"use strict";

/**
 * 长录制会话编排层（扩展宿主持有）。
 *
 * 向上（mainViewProvider / 命令 / UI，后续任务接入）提供 start/status/list/delete 与
 * 采样喂入 ingestSample、断连 noteProbeDisconnected/noteProbeReconnected、
 * 显式占用 noteOccupation/releaseOccupation；向下使用 recordingStorage.js 的
 * RecordingSession（含有界写队列与配额管理器）。
 *
 * 职责边界：
 *   - 每个工作区至多一个活动录制；变量集合在 start 时冻结，图表变量修改不影响录制。
 *   - 录制不依赖图表面板生命周期：图表关闭/冻结/清空/停止绝不终止活动录制。
 *   - 断连只写 gap-start/gap-end 两条内部事件行（kind:"recording-event"），不制造空样本。
 *   - 扩展重启后自动恢复未完成会话：工作区、ELF 哈希、变量类型/地址、硬件配置全部
 *     匹配才续录；任一不匹配置 paused-config（保留全部数据），要求开启新录制。
 *   - 配额超限 → stopped-quota；写失败无法排空 → stopped-error；均保留数据并通知订阅者。
 *
 * 纯 Node 模块：不依赖 vscode。工作区身份取 context.storageUri（VS Code 为每个工作区
 * 分配且跨重启稳定），测试注入仅含 fsPath 的 context 替身即可。
 */

const fs = require("fs");
const path = require("path");

const storage = require("./recordingStorage");

const fsp = fs.promises;

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (timer && typeof timer.unref === "function") timer.unref();
        return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer)
};

/** 带错误码的异常（RECORDING_ACTIVE / CONFIRMATION_REQUIRED / RECORDING_NOT_FOUND）。 */
function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

/**
 * 录制 manifest 的松散类型（字段以 recordingStorage.js 实际写入为准）。
 * @typedef {object} RecordingManifest
 * @property {string} [status] 会话状态
 * @property {number} [createdAtMs] 创建时间
 * @property {number|null} [endedAtMs] 结束时间
 * @property {number} [sequenceCounter] 样本序号计数
 * @property {number} [gapCount] 断连 gap 次数
 * @property {{attempt: number|null, nextAtMs: number|null, updatedAtMs: number}|null} [retry] 退避重试状态
 * @property {{maxMiB: number, globalMaxMiB: number, usedBytes: number}|null} [quota] 配额统计
 * @property {Array<{name: string, type?: string|null, address?: string|null, size?: number|null}>} [fixedVariables] 固定变量
 * @property {Array<{name: string, compressedBytes?: number, bytes?: number}>} [segments] 已封存段
 * @property {{name: string, bytes?: number}|null} [activeSegment] 活动段
 */

/** 递归统计目录实际磁盘占用（字节）；目录不存在按 0 处理。 */
async function directorySizeBytes(dirPath) {
    let entries;
    try {
        entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
    }
    let total = 0;
    for (const entry of entries) {
        const child = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            total += await directorySizeBytes(child);
        } else if (entry.isFile()) {
            try {
                total += (await fsp.stat(child)).size;
            } catch {
                // 并发删除等场景下文件消失：不计入。
            }
        }
    }
    return total;
}

/** 让出事件循环（真实宏任务），用于等待在途 fire-and-forget 追加完成入队。 */
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

/** 校验变量解析结果并投影为固定 schema（name/type/address/size 顺序固定）。 */
function toFixedSchema(resolved) {
    return (Array.isArray(resolved) ? resolved : []).map((variable) => ({
        name: variable && typeof variable.name === "string" ? variable.name : String(variable && variable.name),
        type: variable && variable.type != null ? variable.type : null,
        address: variable && variable.address != null ? String(variable.address) : null,
        size: variable && Number.isFinite(variable.size) ? variable.size : null
    }));
}

/**
 * 长录制服务（由 createRecordingService 创建，不要直接 new）。
 */
class RecordingService {
    constructor(options) {
        const context = options.context;
        if (!context || !context.globalStorageUri || !context.globalStorageUri.fsPath) {
            throw new Error("context.globalStorageUri.fsPath is required");
        }
        this._context = context;
        this._storageRoot = path.join(context.globalStorageUri.fsPath, "recordings");
        // 工作区身份：优先显式注入；否则用 storageUri（VS Code 按工作区分配、跨重启稳定）。
        this._workspacePath =
            typeof options.workspacePath === "string" && options.workspacePath
                ? options.workspacePath
                : (context.storageUri && context.storageUri.fsPath) || context.globalStorageUri.fsPath;
        this._wsHash = storage.workspaceHash(this._workspacePath);
        this._resolveVariables = options.resolveVariables;
        this._elfInfo = options.elfInfo;
        this._hardwareInfo = options.hardwareInfo;
        this._getSamplingInterval =
            typeof options.getSamplingInterval === "function" ? options.getSamplingInterval : () => null;
        this._clock = options.clock || defaultClock;
        this._limits = storage.resolveRecordingLimits(options.limits || {});
        this._quotaManager =
            options.quotaManager ||
            storage.createQuotaManager({
                storageRoot: this._storageRoot,
                maxMiB: this._limits.maxMiB,
                globalMaxMiB: this._limits.globalMaxMiB,
                clock: this._clock
            });

        this._session = null; // 活动 RecordingSession
        this._recordingId = null; // 活动会话 ID
        this._stopState = null; // {kind:"quota"|"error", reason, message} 安全停止闩锁
        this._stopping = false; // stop() 进行中，拒绝新样本
        this._starting = false; // start() 进行中
        this._stopPromise = null; // stop() 单飞任务
        this._pendingIngest = 0; // 在途（未完成入队的）ingestSample 计数
        this._finalizePromise = null; // 安全结束任务（单飞）
        this._gapStartedAtMs = null; // 断连 gap 起始时间
        this._occupations = new Set(); // 下载/调试切换等显式占用
        this._quotaStopSubs = new Set();
        this._safeStopSubs = new Set();
        this._lastSnapshot = null; // 无活动会话时 status() 返回的最近会话快照
        this._resumedRecordingId = null; // 本次实例自动续录的会话 ID
        this._pausedConfigReason = null; // 最近一次恢复匹配失败原因
        this._pausedConfigRecordingId = null;
        // 扩展重启恢复：构造时在后台执行；start/stop/list/delete 内部会等待其完成。
        this._recoveryPromise = this._recoverOnStartup();
        this._recoveryPromise.catch(() => {});
    }

    /** 等待构造时启动的恢复流程完成（返回恢复结果快照；测试与接线方可用）。 */
    whenReady() {
        return this._recoveryPromise.then(() => this.status());
    }

    // ---------------------------------------------------------------- 采样喂入

    /**
     * 喂入一条采样（Task 3 采样管线接线用）。values 按启动时冻结的 schema 顺序排列。
     * 返回 promise（可等待也可忽略）；不等待时数据入队后由后台排空任务落盘，
     * 磁盘慢时积压通过 backpressure/shouldPauseSampling 反馈给采样循环。
     * @param {Array<string|null>} values 固定列 valueText（缺失值 null）
     * @param {{tMs?: number, elapsedMs?: number, source?: string, complete?: boolean,
     *          full?: boolean, timestampMs?: number}} [meta]
     * @returns {Promise<{written: boolean, seq?: number, reason?: string}>}
     */
    async ingestSample(values, meta = {}) {
        const session = this._session;
        if (!session || this._stopping) return { written: false, reason: "not-recording" };
        this._pendingIngest += 1;
        try {
            const result = await session.appendSampleLine({
                source: typeof meta.source === "string" && meta.source ? meta.source : "live",
                full: meta.complete === undefined ? meta.full !== false : meta.complete !== false,
                timestampMs: typeof meta.tMs === "number" ? meta.tMs : meta.timestampMs,
                elapsedMs: typeof meta.elapsedMs === "number" ? meta.elapsedMs : undefined,
                values
            });
            return result.written ? { written: true, seq: result.seq } : { written: false, reason: "rejected" };
        } catch (error) {
            // 写入路径的异常不外泄到采样循环（安全停止已在存储层处理）。
            try {
                session.recordError("ingest-failed", error);
            } catch {
                // 会话已关闭等场景忽略。
            }
            return { written: false, reason: "append-failed" };
        } finally {
            this._pendingIngest -= 1;
        }
    }

    /** 采样是否应暂停：写队列 high/full，或配额/写错误安全停止后保持 true。 */
    shouldPauseSampling() {
        if (this._stopState) return true;
        const session = this._session;
        if (!session) return false;
        const backpressure = session.backpressure;
        return backpressure === "high" || backpressure === "full";
    }

    // ------------------------------------------------------------ 断连与占用

    /** 探针断开：写 gap-start 内部事件行并记录 gap 起始时间；无活动录制时为 no-op。 */
    async noteProbeDisconnected() {
        const session = this._session;
        if (!session || this._gapStartedAtMs != null) return;
        this._gapStartedAtMs = this._clock.now();
        try {
            await session.appendEventLine("gap-start", { atMs: this._gapStartedAtMs });
            await session.updateManifest({ gapCount: (session.manifest.gapCount || 0) + 1 });
        } catch (error) {
            // 事件/清单写入失败不向采样管线外泄，记录到 manifest 错误日志。
            try {
                session.recordError("gap-event-failed", error);
            } catch {
                // 会话已关闭等场景忽略。
            }
        }
    }

    /** 探针恢复：写 gap-end 内部事件行（含 gap 时长）；无未闭合 gap 时为 no-op。 */
    async noteProbeReconnected() {
        const session = this._session;
        if (!session || this._gapStartedAtMs == null) return;
        const endedAtMs = this._clock.now();
        const durationMs = Math.max(0, endedAtMs - this._gapStartedAtMs);
        this._gapStartedAtMs = null;
        try {
            await session.appendEventLine("gap-end", { atMs: endedAtMs, durationMs });
        } catch (error) {
            try {
                session.recordError("gap-event-failed", error);
            } catch {
                // 忽略。
            }
        }
    }

    /**
     * Task 3 的退避重连调度上报：attempt/nextAtMs 写入 manifest。
     * @param {{attempt?: number, nextAtMs?: number}} [retry]
     */
    async noteRetryScheduled({ attempt, nextAtMs } = {}) {
        const session = this._session;
        if (!session) return;
        const patch = {
            retry: {
                attempt: Number.isFinite(attempt) ? attempt : null,
                nextAtMs: Number.isFinite(nextAtMs) ? nextAtMs : null,
                updatedAtMs: this._clock.now()
            }
        };
        try {
            await session.updateManifest(patch);
        } catch (error) {
            session.recordError("retry-manifest-failed", error);
        }
    }

    /** 显式占用（下载/调试切换等）：仅跟踪状态，供采样管线决定是否喂入。 */
    noteOccupation(kind) {
        if (typeof kind === "string" && kind) this._occupations.add(kind);
    }

    /** 释放显式占用。 */
    releaseOccupation(kind) {
        this._occupations.delete(kind);
    }

    // ------------------------------------------------------------- 生命周期

    /**
     * 启动新录制：解析变量得到固定 schema，计算 ELF/硬件身份并写入 manifest。
     * 已有活动录制（或正在结束/启动中）时抛出 RECORDING_ACTIVE。
     * @param {{names?: string[], intervalMs?: number}} [params]
     */
    async start({ names, intervalMs } = {}) {
        await this._recoveryPromise;
        if (this._session || this._starting || this._stopping || this._finalizePromise) {
            throw codedError("RECORDING_ACTIVE", "a recording session is already active");
        }
        this._starting = true;
        // 新会话开始前清除上一次的安全停止闩锁；createSession 期间的新拒绝会重新闩锁。
        this._stopState = null;
        this._stopping = false;
        this._gapStartedAtMs = null;
        try {
            const requestedNames = Array.isArray(names) ? names.map((name) => String(name)) : [];
            const resolved = this._resolveVariables ? await this._resolveVariables(requestedNames) : [];
            const schema = toFixedSchema(resolved);
            const elf = this._elfInfo ? await this._elfInfo() : null;
            const hardware = this._hardwareInfo ? await this._hardwareInfo() : null;
            const configuredInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : null;
            const interval =
                configuredInterval != null ? configuredInterval : this._normalizeInterval(this._getSamplingInterval());

            const session = await storage.createSession({
                storageRoot: this._storageRoot,
                workspaceHash: this._wsHash,
                fixedVariables: schema,
                targetIntervalMs: interval,
                elfSha256: elf && elf.sha256 ? String(elf.sha256) : null,
                mcuId: hardware && hardware.mcu != null ? String(hardware.mcu) : null,
                debuggerId: hardware && hardware.probe != null ? String(hardware.probe) : null,
                limits: this._limits,
                quota: this._quotaManager,
                onQuotaExceeded: (reason) => this._handleQuotaStop(reason),
                onWriteError: (error) => this._handleWriteFailure(error),
                clock: this._clock
            });
            this._session = session;
            this._recordingId = path.basename(session.sessionDir).slice(0, -".eprec".length);
            try {
                // manifest 扩展字段：intervalMs、hardware、workspacePath、含 size 的固定 schema。
                await session.updateManifest({
                    intervalMs: interval,
                    hardware: {
                        mcu: hardware && hardware.mcu != null ? String(hardware.mcu) : null,
                        probe: hardware && hardware.probe != null ? String(hardware.probe) : null
                    },
                    workspacePath: this._workspacePath,
                    fixedVariables: schema
                });
            } catch (error) {
                session.recordError("manifest-extend-failed", error);
            }
            // createSession 阶段配额即拒绝（如打开首段被拒）：立即安全结束。
            if (this._stopState) {
                await this._finalizeSafeStop();
                return this.status();
            }
            this._lastSnapshot = null;
            return this.status();
        } finally {
            this._starting = false;
        }
    }

    /**
     * 停止录制：停止接受新样本 → 等待在途追加入队 → 排空写队列 → 最终同步 →
     * 封口会话（storage close completed）。幂等：重复 stop 直接成功。
     */
    async stop() {
        await this._recoveryPromise;
        if (this._finalizePromise) {
            // 安全结束进行中：等待其完成即可，不再叠加 completed close。
            await this._finalizePromise.catch(() => {});
            return this.status();
        }
        if (!this._stopPromise) {
            const session = this._session;
            if (!session) return this.status();
            this._stopping = true; // 同步拒绝后续 ingestSample
            this._stopPromise = this._stopSession(session);
        }
        try {
            await this._stopPromise;
        } finally {
            this._stopPromise = null;
        }
        return this.status();
    }

    /** stop() 的实际执行体：排空并封口；失败时会话保持打开以便重试 stop()。 */
    async _stopSession(session) {
        try {
            await this._whenIngestSettled();
            await session.close({ status: "completed" });
            this._settleSession(session.manifest.status || "completed");
        } catch (error) {
            try {
                session.recordError("stop-failed", error);
            } catch {
                // 忽略。
            }
            this._lastSnapshot = this._liveSnapshot("interrupted");
        }
    }

    /**
     * 删除录制会话目录并从全局统计扣除。需要二次确认；活动会话必须先 stop。
     * @param {string} recordingId
     * @param {{confirmed?: boolean}} [options]
     */
    async delete(recordingId, { confirmed } = {}) {
        await this._recoveryPromise;
        if (confirmed !== true) {
            throw codedError("CONFIRMATION_REQUIRED", "deletion requires explicit confirmation");
        }
        if (typeof recordingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(recordingId)) {
            throw codedError("RECORDING_NOT_FOUND", `unknown recording id: ${recordingId}`);
        }
        if (this._recordingId && this._recordingId === recordingId && this._session) {
            throw codedError("RECORDING_ACTIVE", "stop the active recording before deleting it");
        }
        const wsDir = path.join(this._storageRoot, this._wsHash);
        const sessionDir = path.resolve(storage.sessionDirFor(this._storageRoot, this._wsHash, recordingId));
        // 防路径逃逸：解析后的目录必须仍位于本工作区存储目录内。
        if (!sessionDir.startsWith(path.resolve(wsDir) + path.sep)) {
            throw codedError("RECORDING_NOT_FOUND", `unknown recording id: ${recordingId}`);
        }
        try {
            await fsp.access(sessionDir);
        } catch {
            throw codedError("RECORDING_NOT_FOUND", `unknown recording id: ${recordingId}`);
        }
        await fsp.rm(sessionDir, { recursive: true, force: true });
        // 全局统计以磁盘为准：删除后 reconcile 把该会话的统计清零扣减。
        try {
            await this._quotaManager.reconcile(sessionDir);
        } catch {
            // 统计校正失败不影响删除结果（新实例会从磁盘重建基线）。
        }
        if (this._lastSnapshot && this._lastSnapshot.recordingId === recordingId) this._lastSnapshot = null;
        if (this._pausedConfigRecordingId === recordingId) {
            this._pausedConfigRecordingId = null;
            this._pausedConfigReason = null;
        }
        return { deleted: recordingId };
    }

    // ------------------------------------------------------------- 查询快照

    /**
     * 活动或最近会话的元数据快照（同步）。无任何会话信息时返回 {status:"none"}。
     * 恢复结果通过 resumed / pausedConfigReason 暴露。
     */
    status() {
        const session = this._session;
        if (session && this._recordingId) {
            const snapshot = this._liveSnapshot(session.manifest.status || "recording");
            return {
                ...snapshot,
                recordingActive: true,
                backpressure: session.backpressure,
                samplingPaused: this.shouldPauseSampling(),
                resumed: this._resumedRecordingId === this._recordingId,
                pausedConfigReason: null,
                gapActive: this._gapStartedAtMs != null,
                occupations: [...this._occupations].sort()
            };
        }
        if (this._lastSnapshot) {
            return {
                ...this._lastSnapshot,
                recordingActive: false,
                backpressure: null,
                samplingPaused: this.shouldPauseSampling(),
                resumed: false,
                pausedConfigReason: this._pausedConfigReason,
                gapActive: false,
                occupations: [...this._occupations].sort()
            };
        }
        return {
            status: "none",
            recordingActive: false,
            backpressure: null,
            samplingPaused: this.shouldPauseSampling(),
            resumed: false,
            pausedConfigReason: this._pausedConfigReason,
            gapActive: false,
            occupations: [...this._occupations].sort()
        };
    }

    /**
     * 列出本工作区全部录制会话的元数据（绝不返回样本正文）。
     * 活动会话的实时行数/字节取自会话内存态；历史会话取自 manifest 与磁盘。
     * @returns {Promise<Array<object>>}
     */
    async list() {
        await this._recoveryPromise;
        const wsDir = path.join(this._storageRoot, this._wsHash);
        let entries = [];
        try {
            entries = await fsp.readdir(wsDir, { withFileTypes: true });
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        const items = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.endsWith(".eprec")) continue;
            const recordingId = entry.name.slice(0, -".eprec".length);
            const sessionDir = path.join(wsDir, entry.name);
            if (this._session && this._recordingId === recordingId) {
                items.push(this._liveSnapshot(this._session.manifest.status || "recording"));
                continue;
            }
            let manifest = null;
            try {
                manifest = await storage.readManifest(sessionDir);
            } catch {
                continue; // manifest 损坏：跳过，等待恢复流程处理。
            }
            if (!manifest) continue;
            let bytes = 0;
            try {
                bytes = await directorySizeBytes(sessionDir);
            } catch {
                bytes = 0;
            }
            items.push(this._snapshotFromManifest(manifest, recordingId, bytes));
        }
        items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        if (!this._session && items.length > 0) this._lastSnapshot = items[0];
        return items;
    }

    // --------------------------------------------------------------- 订阅

    /** 配额安全停止订阅（Task 3 用它暂停采样并保持暂停）。返回取消订阅函数。 */
    onQuotaStop(callback) {
        this._quotaStopSubs.add(callback);
        return () => this._quotaStopSubs.delete(callback);
    }

    /** 写失败安全停止订阅。返回取消订阅函数。 */
    onSafeStop(callback) {
        this._safeStopSubs.add(callback);
        return () => this._safeStopSubs.delete(callback);
    }

    // ------------------------------------------------------------- 内部实现

    _normalizeInterval(value) {
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
    }

    /** 活动会话的实时快照：行数/字节取内存态。 */
    _liveSnapshot(status) {
        const session = this._session;
        const manifest = session ? session.manifest : {};
        let bytes = 0;
        if (session) {
            for (const segment of Array.isArray(manifest.segments) ? manifest.segments : []) {
                bytes += segment.compressedBytes != null ? segment.compressedBytes : segment.bytes || 0;
            }
            if (session.active) bytes += session.active.bytes;
        }
        return this._snapshotFromManifest(manifest, this._recordingId, bytes, status);
    }

    /**
     * 从 manifest 构造元数据快照（仅元数据，绝不包含样本正文/valueText）。
     * @param {RecordingManifest} manifest
     * @param {string} recordingId
     * @param {number} bytes 磁盘/内存字节
     * @param {string} [statusOverride] 覆盖 manifest.status（如安全停止路径）
     */
    _snapshotFromManifest(manifest, recordingId, bytes, statusOverride) {
        return {
            recordingId,
            status: statusOverride || manifest.status || "unknown",
            createdAtMs: manifest.createdAtMs != null ? manifest.createdAtMs : null,
            endedAtMs: manifest.endedAtMs != null ? manifest.endedAtMs : null,
            rows: Number.isFinite(manifest.sequenceCounter) ? manifest.sequenceCounter : 0,
            bytes: Number.isFinite(bytes) ? bytes : 0,
            gaps: manifest.gapCount || 0,
            retries: manifest.retry || null,
            quota: manifest.quota || null,
            fixedVariables: (Array.isArray(manifest.fixedVariables) ? manifest.fixedVariables : []).map((variable) => ({
                name: variable.name,
                type: variable.type != null ? variable.type : null,
                address: variable.address != null ? String(variable.address) : null,
                size: variable.size != null ? variable.size : null
            }))
        };
    }

    /** 会话结束后的统一收尾：清活动态、缓存最近快照、解除采样停止标记。 */
    _settleSession(finalStatus) {
        const session = this._session;
        if (!session) return;
        const recordingId = this._recordingId;
        const manifest = session.manifest;
        // 结算时从 manifest 推导字节：封存段用压缩后大小，活动段用段内字节。
        let bytes = 0;
        for (const segment of Array.isArray(manifest.segments) ? manifest.segments : []) {
            bytes += segment.compressedBytes != null ? segment.compressedBytes : segment.bytes || 0;
        }
        if (manifest.activeSegment && manifest.activeSegment.bytes) bytes += manifest.activeSegment.bytes;
        this._lastSnapshot = this._snapshotFromManifest(manifest, recordingId, bytes, finalStatus);
        this._session = null;
        this._recordingId = null;
        this._gapStartedAtMs = null;
        this._stopping = false;
    }

    /** 等待在途 fire-and-forget 追加全部完成（入队或被拒绝）。 */
    async _whenIngestSettled() {
        let guard = 0;
        while (this._pendingIngest > 0 && guard < 10000) {
            guard += 1;
            await yieldToEventLoop();
        }
    }

    /** 配额拒绝（storage onQuotaExceeded）：闩锁 + 通知订阅者 + 延迟安全结束。 */
    _handleQuotaStop(reason) {
        if (this._stopState) return;
        this._stopState = { kind: "quota", reason: reason || "quota-exceeded" };
        this._notify(this._quotaStopSubs, { reason: this._stopState.reason });
        // 启动流程中的拒绝由 start() 的创建后检查收尾；其余场景延迟安全结束
        // （不在存储写入路径内同步 close，避免重入死锁）。
        if (!this._starting) void this._finalizeSafeStop();
    }

    /** 写失败（storage onWriteError）：闩锁 + 通知订阅者 + 延迟安全结束。 */
    _handleWriteFailure(error) {
        if (this._stopState) return;
        this._stopState = {
            kind: "error",
            reason: "write-failed",
            message: error && error.message ? error.message : String(error)
        };
        this._notify(this._safeStopSubs, { reason: "write-failed", message: this._stopState.message });
        if (!this._starting) void this._finalizeSafeStop();
    }

    _notify(subscribers, payload) {
        for (const callback of subscribers) {
            try {
                const result = callback(payload);
                if (result && typeof result.catch === "function") result.catch(() => {});
            } catch {
                // 订阅者异常不外泄。
            }
        }
    }

    /**
     * 安全结束（单飞）：等待在途追加入队后按安全停止状态关闭会话
     * （非 completed close，保留全部数据）。配额 → "stopped-quota"；写失败 → "stopped-error"。
     */
    async _finalizeSafeStop() {
        if (this._finalizePromise) return this._finalizePromise;
        this._finalizePromise = (async () => {
            const status = this._stopState && this._stopState.kind === "quota" ? "stopped-quota" : "stopped-error";
            try {
                await this._whenIngestSettled();
                const session = this._session;
                if (session) {
                    try {
                        await session.close({ status });
                    } catch (error) {
                        try {
                            session.recordError("safe-stop-failed", error);
                        } catch {
                            // 忽略。
                        }
                    }
                }
            } finally {
                this._stopping = true;
                this._settleSession(status);
            }
        })();
        try {
            await this._finalizePromise;
        } finally {
            this._finalizePromise = null;
        }
    }

    // ------------------------------------------------------- 扩展重启恢复

    /**
     * 构造时恢复：扫描本工作区下 status 为 recording/interrupted 的未完成会话，
     * 取最新一个尝试自动续录；其余（含匹配失败者）置 paused-config 保留数据。
     */
    async _recoverOnStartup() {
        let candidates = [];
        try {
            candidates = await this._findUnfinishedSessions();
        } catch (error) {
            this._recoveryError = error;
            return;
        }
        if (candidates.length === 0) return;
        candidates.sort((a, b) => (b.manifest.createdAtMs || 0) - (a.manifest.createdAtMs || 0));
        const newest = candidates[0];
        // 每个工作区只允许一个活动录制：其余未完成会话全部置 paused-config（数据保留）。
        for (const other of candidates.slice(1)) {
            await this._markPausedConfig(other.sessionDir, "superseded");
        }
        const identity = await this._currentIdentity(newest.manifest);
        const mismatch = this._matchForResume(newest.manifest, identity);
        if (mismatch) {
            await this._markPausedConfig(newest.sessionDir, mismatch);
            this._pausedConfigReason = mismatch;
            this._pausedConfigRecordingId = newest.recordingId;
            // 最近会话快照指向该 paused-config 会话，供 status() 展示。
            try {
                const manifest = await storage.readManifest(newest.sessionDir);
                if (manifest) {
                    this._lastSnapshot = this._snapshotFromManifest(
                        manifest,
                        newest.recordingId,
                        await directorySizeBytes(newest.sessionDir)
                    );
                }
            } catch {
                // 读取失败不影响恢复结果。
            }
            return;
        }
        try {
            const session = await storage.openSession({
                sessionDir: newest.sessionDir,
                clock: this._clock,
                quota: this._quotaManager,
                onQuotaExceeded: (reason) => this._handleQuotaStop(reason),
                onWriteError: (error) => this._handleWriteFailure(error)
            });
            this._session = session;
            this._recordingId = newest.recordingId;
            this._resumedRecordingId = newest.recordingId;
            this._fixedSchema = toFixedSchema(identity.variables);
            await session.updateManifest({ status: "recording" });
        } catch (error) {
            // 续录失败（磁盘故障等）：不吞数据，会话保留原状并记录原因。
            this._recoveryError = error;
            this._session = null;
            this._recordingId = null;
            this._resumedRecordingId = null;
        }
    }

    /** 扫描本工作区存储目录下的未完成会话（manifest.status 为 recording/interrupted）。 */
    async _findUnfinishedSessions() {
        const wsDir = path.join(this._storageRoot, this._wsHash);
        let entries = [];
        try {
            entries = await fsp.readdir(wsDir, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return [];
            throw error;
        }
        const found = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.endsWith(".eprec")) continue;
            const sessionDir = path.join(wsDir, entry.name);
            let manifest = null;
            try {
                manifest = await storage.readManifest(sessionDir);
            } catch {
                manifest = null; // manifest 损坏：交给 recoverSession 在匹配/收尾阶段处理。
            }
            if (manifest && (manifest.status === "recording" || manifest.status === "interrupted")) {
                found.push({
                    sessionDir,
                    recordingId: entry.name.slice(0, -".eprec".length),
                    manifest
                });
            }
        }
        return found;
    }

    /** 取当前运行时身份：ELF 哈希、硬件信息与固定变量的当前解析结果。 */
    async _currentIdentity(manifest) {
        let elf = null;
        let hardware = null;
        let variables = [];
        const names = (Array.isArray(manifest.fixedVariables) ? manifest.fixedVariables : []).map((v) => v.name);
        try {
            elf = this._elfInfo ? await this._elfInfo() : null;
        } catch {
            elf = null; // 无法验证 ELF 身份：按不匹配处理（保守，绝不混入不同固件的数据）。
        }
        try {
            hardware = this._hardwareInfo ? await this._hardwareInfo() : null;
        } catch {
            hardware = null;
        }
        try {
            variables = this._resolveVariables ? await this._resolveVariables(names) : [];
        } catch {
            variables = [];
        }
        return { elf, hardware, variables: toFixedSchema(variables) };
    }

    /**
     * 恢复匹配：工作区（目录即含）、ELF 哈希、fixedVariables 的 type/address、硬件配置
     * 全部一致返回 null；任一不匹配返回原因（elf-changed / variables-changed / hardware-changed）。
     */
    _matchForResume(manifest, identity) {
        const currentElf = identity.elf && identity.elf.sha256 ? String(identity.elf.sha256) : null;
        const storedElf = manifest.elfSha256 != null ? String(manifest.elfSha256) : null;
        if (!currentElf || currentElf !== storedElf) return "elf-changed";
        const stored = Array.isArray(manifest.fixedVariables) ? manifest.fixedVariables : [];
        const current = identity.variables;
        if (stored.length !== current.length) return "variables-changed";
        for (let index = 0; index < stored.length; index += 1) {
            const before = stored[index];
            const after = current[index];
            if (!after || after.name !== before.name) return "variables-changed";
            if (
                (before.type != null ? String(before.type) : null) !== (after.type != null ? String(after.type) : null)
            ) {
                return "variables-changed";
            }
            if ((before.address != null ? String(before.address) : null) !== after.address) {
                return "variables-changed";
            }
        }
        const storedHardware = manifest.hardware || {};
        const currentHardware = identity.hardware || {};
        const normalize = (hardware) => ({
            mcu: hardware.mcu != null ? String(hardware.mcu) : null,
            probe: hardware.probe != null ? String(hardware.probe) : null
        });
        const before = normalize(storedHardware);
        const after = normalize(currentHardware);
        if (before.mcu !== after.mcu || before.probe !== after.probe) return "hardware-changed";
        return null;
    }

    /** 把未完成会话置为 paused-config：先走 recoverSession（截断残缺尾行等）再改状态。 */
    async _markPausedConfig(sessionDir, reason) {
        try {
            const session = await storage.openSession({ sessionDir, clock: this._clock });
            try {
                await session.updateManifest({ pausedConfigReason: reason });
                await session.close({ status: "paused-config" });
            } catch (error) {
                try {
                    session.recordError("paused-config-failed", error);
                } catch {
                    // 忽略。
                }
                try {
                    await session.close({ status: "paused-config" });
                } catch {
                    // 尽力关闭；失败时保留 interrupted 语义。
                }
            }
        } catch {
            // openSession 失败（目录不可读等）：保留原状，不销毁任何数据。
        }
    }
}

/**
 * 创建长录制会话编排服务。
 * @param {object} options
 * @param {object} options.context vscode ExtensionContext（测试可注入仅含 globalStorageUri/storageUri
 *   fsPath 的替身）；storageRoot = globalStorageUri.fsPath/recordings
 * @param {Function} [options.resolveVariables] async (names) => [{name, type, address, size}]
 * @param {Function} [options.elfInfo] async () => ({sha256, mtimeMs})
 * @param {Function} [options.hardwareInfo] async () => ({mcu, probe})
 * @param {Function} [options.getSamplingInterval] () => 当前采样间隔 ms（用于默认间隔）
 * @param {{maxMiB?: number, globalMaxMiB?: number}} [options.limits] 已解析的配额上限
 * @param {object} [options.clock] 可注入时钟 {now, setTimeout, clearTimeout}
 * @param {object} [options.quotaManager] 可注入配额管理器（测试替身）；缺省时按 limits 创建
 * @param {string} [options.workspacePath] 显式工作区路径；缺省用 context.storageUri.fsPath
 * @returns {RecordingService}
 */
function createRecordingService(options) {
    return new RecordingService(options);
}

module.exports = {
    createRecordingService,
    RecordingService
};

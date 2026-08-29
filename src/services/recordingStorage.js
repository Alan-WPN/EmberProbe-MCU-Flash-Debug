"use strict";

/**
 * 长录制持久化存储引擎。
 *
 * 会话目录布局：<storageRoot>/<workspace-hash>/<recording-id>.eprec/
 *   - manifest.json               原子更新的会话清单
 *   - seg-NNNNNN.ndjson.part      可断点续录的活动段（NDJSON，每行一个采样）
 *   - seg-NNNNNN.ndjson.gz        封存后的无损 gzip 压缩段
 *
 * 采样行格式（固定列顺序与 manifest.fixedVariables 一致）：
 *   {"seq":1,"ts":1690000000000,"el":100,"src":"live","full":true,"v":["1.23",null,"0x10"]}\n
 *
 * 纯 Node 模块：不依赖 vscode，storageRoot 由调用方注入。
 *
 * 配额管理：createQuotaManager 提供跨进程锁保护的全局用量统计，在创建分段与压缩
 * 临时文件前预留空间；达到上限时安全停止并保留已有数据，绝不截断、绝不循环覆盖。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const fsp = fs.promises;

// fs.promises 没有裸 fd 的 fdatasync；用回调版包装，并通过自有对象引用，
// 使测试可以观测/注入 fdatasync、rename 与 writeFd（写队列慢磁盘/EIO 注入点）。
const io = {
    /** @type {(fd: number) => Promise<void>} */
    fdatasync: (fd) =>
        new Promise((resolve, reject) => {
            fs.fdatasync(fd, (error) => (error ? reject(error) : resolve()));
        }),
    rename: (from, to) => fsp.rename(from, to),
    writeFd: (fd, buffer) => writeFd(fd, buffer)
};

const FORMAT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const SEGMENT_MAX_AGE_MS = 5 * 60 * 1000;
const SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const SYNC_INTERVAL_MS = 1000;
// 有界写队列水位：默认高水位 8 MiB（编排层暂停采样）、硬上限 16 MiB（拒绝新样本）、
// 低水位 4 MiB（排空到该值以下视为恢复并向 NDJSON 写内部恢复事件）。
const WRITE_QUEUE_HIGH_WATERMARK_BYTES = 8 * 1024 * 1024;
const WRITE_QUEUE_HARD_MAX_BYTES = 16 * 1024 * 1024;
const WRITE_QUEUE_LOW_WATERMARK_BYTES = 4 * 1024 * 1024;
const MAX_MIB_LIMITS = { min: 64, max: 102400, fallback: 1024 };
const GLOBAL_MAX_MIB_LIMITS = { min: 128, max: 204800, fallback: 2048 };
const QUOTA_LOCK_FILE = "quota.lock";
const QUOTA_LOCK_STALE_MS = 10 * 1000;
const QUOTA_LOCK_RETRY_MS = 50;
const QUOTA_LOCK_RETRY_LIMIT = 20;
const BYTES_PER_MIB = 1024 * 1024;

/**
 * 可注入时钟（与 recordingService/recorderSampler 的 clock 契约一致）。
 * @typedef {{now: () => number, setTimeout: (fn: () => void, ms: number) => any,
 *            clearTimeout: (timer: any) => void}} RecordingClock
 */

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (timer && typeof timer.unref === "function") timer.unref();
        return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer)
};

/** 校验/收敛录制配额（MiB）：非法值回退默认值，越界值收敛到范围内。 */
function clampMiB(value, limits) {
    if (typeof value !== "number" || !Number.isFinite(value)) return limits.fallback;
    return Math.min(limits.max, Math.max(limits.min, Math.floor(value)));
}

/**
 * 解析 emberprobe.recordingMaxMiB / emberprobe.recordingGlobalMaxMiB 配置。
 * @param {{maxMiB?: number, globalMaxMiB?: number}} values
 * @returns {{maxMiB: number, globalMaxMiB: number}}
 */
function resolveRecordingLimits(values = {}) {
    return {
        maxMiB: clampMiB(values.maxMiB, MAX_MIB_LIMITS),
        globalMaxMiB: clampMiB(values.globalMaxMiB, GLOBAL_MAX_MIB_LIMITS)
    };
}

/** 工作区路径 → 16 位十六进制哈希，用于存储根下的工作区目录。 */
function workspaceHash(workspacePath) {
    return crypto.createHash("sha256").update(String(workspacePath), "utf8").digest("hex").slice(0, 16);
}

/** 会话目录：<storageRoot>/<workspace-hash>/<recording-id>.eprec */
function sessionDirFor(storageRoot, wsHash, recordingId) {
    return path.join(storageRoot, wsHash, `${recordingId}.eprec`);
}

function nextRecordingId(nowMs = Date.now()) {
    const stamp = new Date(nowMs)
        .toISOString()
        .replace(/[-:T.]/g, "")
        .slice(0, 14);
    return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function openFd(filePath, flags) {
    return new Promise((resolve, reject) => {
        fs.open(filePath, flags, (error, fd) => (error ? reject(error) : resolve(fd)));
    });
}

/** @returns {Promise<void>} */
function closeFd(fd) {
    return new Promise((resolve, reject) => {
        fs.close(fd, (error) => (error ? reject(error) : resolve()));
    });
}

/** @returns {Promise<void>} */
function writeFd(fd, buffer) {
    return new Promise((resolve, reject) => {
        fs.write(fd, buffer, 0, buffer.length, (error, written) => {
            if (error) return reject(error);
            if (written !== buffer.length) {
                return reject(new Error(`short write: only ${written} of ${buffer.length} bytes written`));
            }
            resolve();
        });
    });
}

/** 原子写文件：同目录临时文件 → fdatasync → rename 覆盖，失败时清理临时文件。 */
async function atomicWriteFile(dir, name, buffer) {
    const tmpPath = path.join(dir, `${name}.tmp`);
    try {
        const fd = await openFd(tmpPath, "w");
        try {
            await io.writeFd(fd, buffer);
            await io.fdatasync(fd);
        } finally {
            await closeFd(fd);
        }
        await io.rename(tmpPath, path.join(dir, name));
    } catch (error) {
        // 任何一步失败都清理临时文件，且不掩盖原始错误。
        try {
            await fsp.unlink(tmpPath);
        } catch {
            // 临时文件不存在或已清理。
        }
        throw error;
    }
}

/** 读取 manifest.json；不存在时返回 null。 */
async function readManifest(sessionDir) {
    try {
        return JSON.parse(await fsp.readFile(path.join(sessionDir, MANIFEST_FILE), "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function writeManifest(sessionDir, manifest) {
    await atomicWriteFile(sessionDir, MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
}

/** gzip 压缩整个文件到目标路径，写入完成后先 fdatasync 再返回（调用方负责原子改名）。 */
async function gzipFileTo(srcPath, destPath) {
    const fd = await openFd(destPath, "w");
    try {
        const out = fs.createWriteStream(null, { fd, autoClose: false });
        await pipeline(fs.createReadStream(srcPath), zlib.createGzip(), out);
        await io.fdatasync(fd);
    } finally {
        await closeFd(fd);
    }
}

/**
 * 一个正在进行的录制会话。
 * 通过 createSession / openSession 创建，不要直接 new。
 */
class RecordingSession {
    constructor({
        sessionDir,
        manifest,
        clock = defaultClock,
        segmentMaxBytes = SEGMENT_MAX_BYTES,
        segmentMaxAgeMs = SEGMENT_MAX_AGE_MS,
        syncIntervalMs = SYNC_INTERVAL_MS,
        quota = null,
        onQuotaExceeded = null,
        onWriteError = null,
        writeQueueHighWatermarkBytes = WRITE_QUEUE_HIGH_WATERMARK_BYTES,
        writeQueueHardMaxBytes = WRITE_QUEUE_HARD_MAX_BYTES,
        writeQueueLowWatermarkBytes = WRITE_QUEUE_LOW_WATERMARK_BYTES
    }) {
        this.sessionDir = sessionDir;
        this.manifest = manifest;
        this.clock = clock;
        this.segmentMaxBytes = segmentMaxBytes;
        this.segmentMaxAgeMs = segmentMaxAgeMs;
        this.syncIntervalMs = syncIntervalMs;
        this.quota = quota;
        this.onQuotaExceeded = onQuotaExceeded;
        this.onWriteError = onWriteError;
        this.writeQueueHighWatermarkBytes = writeQueueHighWatermarkBytes;
        this.writeQueueHardMaxBytes = writeQueueHardMaxBytes;
        this.writeQueueLowWatermarkBytes = writeQueueLowWatermarkBytes;
        // 配额拒绝后的安全停止原因；null 表示未停止（未注入 quota 时永远为 null）。
        this.quotaStopReason = null;
        // 写失败（ENOSPC/EIO 等）后的安全停止原因；null 表示写入通道正常。
        this.writeFailedReason = null;
        this.active = null;
        this.closed = false;
        this._dirty = false;
        this._syncTimer = null;
        // 有界写队列：appendSampleLine 入队并尽快异步排空；条目携带 ticket 用于
        // "我的行是否已落盘"等待。样本行 seq 记入 manifest.sequenceCounter，
        // 内部事件行（kind:"recording-event"）不占样本序号。
        this._queue = [];
        this._pendingBytes = 0;
        this._enqueueTicket = 0;
        this._writtenTicket = 0;
        this._writtenSeq = 0;
        this._drainTask = null;
        this._drainPending = false;
        this._backpressureActive = false;
        this._backpressureSinceMs = null;
        // 段状态变更（轮换封存/开新段）的串行化锁，避免并发追加时双重封存。
        this._segmentLock = Promise.resolve();
    }

    /**
     * 背压状态："none" | "high"（编排层应暂停采样）| "full"（≥ 硬上限，拒绝新样本）。
     * 带迟滞：进入 "high" 在待写字节 ≥ 高水位时；此后即使排空到 [低水位, 高水位)
     * 区间也保持 "high"，直到排空到低水位以下（恢复事件写盘点）才回到 "none"，
     * 与 _backpressureActive/_maybeResumeFromBackpressure 的内部状态机一致，
     * 避免编排层在高水位附近快速暂停/恢复震荡。
     */
    get backpressure() {
        if (this._pendingBytes >= this.writeQueueHardMaxBytes) return "full";
        if (
            this._pendingBytes >= this.writeQueueHighWatermarkBytes ||
            (this._backpressureActive && this._pendingBytes >= this.writeQueueLowWatermarkBytes)
        ) {
            return "high";
        }
        return "none";
    }

    /** 活动段 .part 文件绝对路径；无活动段时为 null。 */
    get activeFilePath() {
        return this.active ? this.active.filePath : null;
    }

    _ensureOpen() {
        if (this.closed) throw new Error("recording session is closed");
    }

    /**
     * 尝试为即将进行的写入预留配额；返回 false 表示配额拒绝，会话已转入安全停止。
     * 配额管理器抛出的异常同样按拒绝处理，保证写入路径不产生未处理异常。
     */
    async _reserveQuota(bytes) {
        if (!this.quota) return true;
        let result;
        try {
            result = await this.quota.reserve(this.sessionDir, bytes);
        } catch (error) {
            result = { ok: false, reason: "quota-manager-error", error: error && error.message };
        }
        if (result && result.ok) return true;
        await this._handleQuotaRejection(result);
        return false;
    }

    /** 配额拒绝的统一处理：记录并持久化错误日志、标记安全停止并通知 onQuotaExceeded 回调。 */
    async _handleQuotaRejection(result) {
        if (!this.quotaStopReason) {
            this.quotaStopReason = (result && result.reason) || "quota-exceeded";
            this.recordError("quota-exceeded", new Error(this.quotaStopReason));
            try {
                await writeManifest(this.sessionDir, this.manifest);
            } catch {
                // 磁盘配额/IO 异常时持久化可能失败：内存态已记录，不阻塞安全停止。
            }
        }
        if (typeof this.onQuotaExceeded === "function") {
            try {
                await this.onQuotaExceeded(this.quotaStopReason, result);
            } catch {
                // 回调异常不外泄，写入路径保持安全。
            }
        }
    }

    /** 配额停止后的占位返回：采样不写入，已入队/已写数据保持原样。 */
    _appendRejected() {
        return { seq: this.manifest.sequenceCounter, line: "", written: false };
    }

    /** 下一个段序号：扫描 manifest 与磁盘上已有段文件取最大索引 + 1。 */
    async _nextSegmentIndex() {
        let maxIndex = 0;
        for (const segment of Array.isArray(this.manifest.segments) ? this.manifest.segments : []) {
            const match = segment && segment.name ? /^seg-(\d+)$/.exec(segment.name) : null;
            if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
        }
        for (const entry of await fsp.readdir(this.sessionDir)) {
            const match = /^seg-(\d+)\.ndjson\.(?:part|gz)$/.exec(entry);
            if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
        }
        return maxIndex + 1;
    }

    /**
     * 打开新的活动段。注入配额管理器时，先按段大小上限（segmentMaxBytes）预留空间：
     * 追加写入不再逐条预留，段内增长被该预留覆盖。预留被拒绝时返回 false
     * （会话已转入安全停止），绝不创建段文件。
     * @returns {Promise<boolean>} 是否成功打开
     */
    async _openNewSegment() {
        if (this.quota) {
            const reserved = await this._reserveQuota(this.segmentMaxBytes);
            if (!reserved) return false;
        }
        const name = `seg-${String(await this._nextSegmentIndex()).padStart(6, "0")}`;
        const file = `${name}.ndjson.part`;
        const filePath = path.join(this.sessionDir, file);
        const fd = await openFd(filePath, "a");
        const previousActiveSegment = this.manifest.activeSegment;
        this.active = { name, file, filePath, fd, samples: 0, bytes: 0, createdAtMs: this.clock.now() };
        this.manifest.activeSegment = { name, file, createdAtMs: this.active.createdAtMs, samples: 0, bytes: 0 };
        try {
            await writeManifest(this.sessionDir, this.manifest);
        } catch (error) {
            // manifest 写入失败：关闭已打开的 fd 并回滚内存状态，避免句柄泄漏。
            this.active = null;
            this.manifest.activeSegment = previousActiveSegment;
            try {
                await closeFd(fd);
            } catch {
                // fd 关闭失败不掩盖原始错误。
            }
            throw error;
        }
        // 段可用后拉起排空器：处理轮换/配额窗口期间滞留队列中的内部事件行。
        if (this._queue.length > 0) this._kickDrainer();
        return true;
    }

    _buildLine(sample, seq) {
        const ts = typeof sample.timestampMs === "number" ? sample.timestampMs : this.clock.now();
        const el =
            typeof sample.elapsedMs === "number"
                ? sample.elapsedMs
                : Math.max(0, ts - (this.manifest.startedAtMs ?? ts));
        const values = this.manifest.fixedVariables.map((column, index) => {
            const value = Array.isArray(sample.values) ? sample.values[index] : null;
            return value === undefined || value === null ? null : String(value);
        });
        return (
            JSON.stringify({
                seq,
                ts,
                el,
                src: typeof sample.source === "string" ? sample.source : "live",
                full: sample.full !== false,
                v: values
            }) + "\n"
        );
    }

    /**
     * 追加一条采样行。自动分配递增序号并入有界写队列，由单个后台排空任务尽快写入
     * 活动段；队列在进入时为空时等待本行真正落盘后返回（保持串行调用下的即时可见性），
     * 队列积压时立即返回以允许积压（编排层通过 backpressure 暂停喂入）。
     * 配额拒绝或写失败时安全返回 written:false 占位结果且不抛出异常，
     * 已入队的数据原样保留。
     * @param {{source?: string, full?: boolean, timestampMs?: number, elapsedMs?: number, values?: Array}} sample
     *   values 为固定列的 valueText 数组（按 fixedVariables 顺序），缺失值传 null。
     * @returns {Promise<{seq: number, line: string, written: boolean}>}
     */
    async appendSampleLine(sample) {
        this._ensureOpen();
        if (this.quotaStopReason) return this._appendRejected();
        if (this.writeFailedReason) return this._appendRejected();
        // 队列达到硬上限：拒绝新样本（不丢弃已入队样本），编排层据此暂停采样。
        if (this._pendingBytes >= this.writeQueueHardMaxBytes) {
            this._markBackpressureActive();
            return this._appendRejected();
        }
        await this._ensureReadyForAppend();
        if (this.closed) return this._appendRejected();
        if (this.quotaStopReason) return this._appendRejected();
        if (!this.active) return this._appendRejected();
        // 入队点的硬上限复查：并发/连续 fire-and-forget 调用间的真实积压以此时为准。
        if (this._pendingBytes >= this.writeQueueHardMaxBytes) {
            this._markBackpressureActive();
            return this._appendRejected();
        }
        const seq = this.manifest.sequenceCounter + 1;
        const line = this._buildLine(sample, seq);
        const buffer = Buffer.from(line, "utf8");
        const ticket = ++this._enqueueTicket;
        const queueWasEmpty = this._queue.length === 0;
        this._enqueueLine(buffer, seq, ticket);
        this.manifest.sequenceCounter = seq;
        this.active.samples += 1;
        this.active.bytes += buffer.length;
        this._markDirty();
        this._markBackpressureActive();
        this._kickDrainer();
        if (queueWasEmpty) {
            // 队列原本为空：等待本行落盘，保证串行调用后数据立即可见。
            await this._waitForTicket(ticket);
            if (this._writtenTicket < ticket) return { seq, line, written: false };
        }
        return { seq, line, written: true };
    }

    /**
     * 追加一条内部事件行（kind:"recording-event"），不占用样本序号、不计入行数统计。
     * 用于断连 gap-start/gap-end 与写队列恢复等内部状态事件；导出侧按 kind 过滤。
     * 等待事件行落盘后返回，保证事件与相邻样本行的先后顺序。
     * @param {string} event 事件名（如 "gap-start" / "gap-end" / "backpressure-resume"）
     * @param {object} [extra] 额外字段（如 gap 时长）
     * @returns {Promise<{written: boolean}>}
     */
    async appendEventLine(event, extra = {}) {
        this._ensureOpen();
        if (this.quotaStopReason || this.writeFailedReason) return { written: false };
        const payload = { kind: "recording-event", event, ts: this.clock.now(), ...extra };
        const buffer = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
        const ticket = ++this._enqueueTicket;
        this._enqueueLine(buffer, null, ticket);
        if (this.active) this.active.bytes += buffer.length;
        this._markDirty();
        this._kickDrainer();
        await this._waitForTicket(ticket);
        return { written: this._writtenTicket >= ticket };
    }

    /** 入队一条原始行（样本或内部事件），更新待写字节计数。 */
    _enqueueLine(buffer, seq, ticket) {
        this._queue.push({ buffer, seq, ticket });
        this._pendingBytes += buffer.length;
    }

    /** 待写字节进入高水位及以上时标记背压激活（恢复时用于写内部事件）。 */
    _markBackpressureActive() {
        if (this._backpressureActive) return;
        if (this._pendingBytes < this.writeQueueHighWatermarkBytes) return;
        this._backpressureActive = true;
        this._backpressureSinceMs = this.clock.now();
    }

    /**
     * 准备可写的活动段：必要时按大小/时间轮换封存并打开新段。
     * 段状态变更在独立锁内串行化，避免并发追加导致的双重封存/双重开段。
     */
    async _ensureReadyForAppend() {
        await this._withSegmentLock(async () => {
            if (this.closed || this.quotaStopReason) return;
            if (this.active) await this._rotateIfDue();
            if (!this.active && !this.quotaStopReason) await this._openNewSegment();
        });
    }

    /** 段状态变更锁：串行化执行，单个任务失败不中断后续排队任务。 */
    _withSegmentLock(action) {
        const run = this._segmentLock.then(action);
        this._segmentLock = run.catch(() => {});
        return run;
    }

    /** 等待指定 ticket 的行落盘；写失败/会话关闭/排空器停止时提前返回。 */
    async _waitForTicket(ticket) {
        for (;;) {
            if (this._writtenTicket >= ticket) return true;
            if (this.closed || this.writeFailedReason) return false;
            if (!this._drainTask) return false;
            await this._drainTask;
        }
    }

    /** 启动后台排空任务（单飞）；任务期间新入队的数据由循环继续处理。 */
    _kickDrainer() {
        if (this._drainTask) {
            this._drainPending = true;
            return;
        }
        this._drainTask = this._drainLoop()
            .catch((error) => this.recordError("drain-crashed", error))
            .finally(() => {
                this._drainTask = null;
                // 排空器退出与最后一次 kick 之间存在窗口：退出后若仍有积压则重新拉起。
                if (this._drainPending) {
                    this._drainPending = false;
                    if (this._queue.length > 0 && !this.writeFailedReason && this.active && !this.closed) {
                        this._kickDrainer();
                    }
                }
            });
    }

    /** 排空循环：批量取出待写行合并为单次写入；写失败时原样放回队列并转入安全停止。 */
    async _drainLoop() {
        for (;;) {
            if (this._queue.length === 0) return;
            if (!this.active) return; // 段不可用（轮换/配额停止窗口）：数据保留，等待下次拉起
            if (this.writeFailedReason) return;
            if (this.closed) return;
            const batch = this._queue.splice(0, this._queue.length);
            const bytes = batch.length === 1 ? batch[0].buffer : Buffer.concat(batch.map((entry) => entry.buffer));
            let maxSeq = this._writtenSeq;
            let maxTicket = this._writtenTicket;
            for (const entry of batch) {
                if (entry.seq != null && entry.seq > maxSeq) maxSeq = entry.seq;
                if (entry.ticket > maxTicket) maxTicket = entry.ticket;
            }
            try {
                await io.writeFd(this.active.fd, bytes);
            } catch (error) {
                // 写失败：数据原样放回队首（绝不静默丢弃），转入安全结束路径。
                this._queue = batch.concat(this._queue);
                this._handleWriteError(error);
                return;
            }
            this._writtenSeq = maxSeq;
            this._writtenTicket = maxTicket;
            this._pendingBytes -= bytes.length;
            if (this._pendingBytes < 0) this._pendingBytes = 0;
            this._maybeResumeFromBackpressure();
        }
    }

    /** 排空到低水位以下：解除背压并按需向 NDJSON 写一条内部恢复事件。 */
    _maybeResumeFromBackpressure() {
        if (!this._backpressureActive) return;
        if (this._pendingBytes >= this.writeQueueLowWatermarkBytes) return;
        this._backpressureActive = false;
        const pausedMs =
            this._backpressureSinceMs == null ? 0 : Math.max(0, this.clock.now() - this._backpressureSinceMs);
        this._backpressureSinceMs = null;
        if (this.quotaStopReason || this.writeFailedReason || this.closed) return;
        const payload = { kind: "recording-event", event: "backpressure-resume", ts: this.clock.now(), pausedMs };
        const buffer = Buffer.from(JSON.stringify(payload) + "\n", "utf8");
        this._enqueueLine(buffer, null, ++this._enqueueTicket);
        if (this.active) this.active.bytes += buffer.length;
        this._kickDrainer();
    }

    /** 写失败（ENOSPC/EIO 等）的统一处理：记录、持久化错误日志并通知 onWriteError。 */
    _handleWriteError(error) {
        if (this.writeFailedReason) return;
        this.writeFailedReason = (error && error.code) || "write-failed";
        this.recordError("write-failed", error);
        // 尽力把错误日志持久化到 manifest（失败时内存态已记录，由后续写盘兜底）。
        void writeManifest(this.sessionDir, this.manifest).catch(() => {});
        if (typeof this.onWriteError === "function") {
            try {
                this.onWriteError(error);
            } catch {
                // 回调异常不外泄，写入路径保持安全。
            }
        }
    }

    /**
     * 最终排空尝试（close 前调用）：绕过写失败闸门，把队列中剩余数据一次性尽力写入
     * 当前活动段；仍失败时显式记录丢失数量后清空队列（绝不静默丢弃）。
     */
    async _finalDrainAttempt() {
        if (this._queue.length === 0) return;
        const batch = this._queue.splice(0, this._queue.length);
        const bytes = batch.length === 1 ? batch[0].buffer : Buffer.concat(batch.map((entry) => entry.buffer));
        const lostLines = batch.length;
        const lostBytes = bytes.length;
        const highestSeq = batch.reduce((max, entry) => (entry.seq != null && entry.seq > max ? entry.seq : max), 0);
        const highestTicket = batch.reduce(
            (max, entry) => (entry.ticket > max ? entry.ticket : max),
            this._writtenTicket
        );
        try {
            if (!this.active) throw new Error("no active segment to drain into");
            await io.writeFd(this.active.fd, bytes);
            this._writtenTicket = Math.max(this._writtenTicket, highestTicket);
            this._writtenSeq = Math.max(this._writtenSeq, highestSeq);
            this._pendingBytes = Math.max(0, this._pendingBytes - bytes.length);
            this.writeFailedReason = null; // 最终重试成功：解除写失败闩锁
        } catch (error) {
            this.recordError(
                "queue-bytes-lost",
                new Error(
                    `${lostLines} queued lines / ${lostBytes} bytes could not be written before close: ${error && error.message}`
                )
            );
            this._pendingBytes = Math.max(0, this._pendingBytes - bytes.length);
        }
    }

    /** 批量追加采样行。 */
    async appendSampleLines(samples) {
        const appended = [];
        for (const sample of samples) appended.push(await this.appendSampleLine(sample));
        return appended;
    }

    _markDirty() {
        this._dirty = true;
        if (!this._syncTimer) {
            this._syncTimer = this.clock.setTimeout(() => {
                this._syncTimer = null;
                void this.syncPending().catch((error) => this.recordError("sync-failed", error));
            }, this.syncIntervalMs);
        }
    }

    /** 有待同步数据时执行一次批量 fdatasync；无脏数据时不做任何事。 */
    async syncPending() {
        if (!this._dirty || !this.active) return false;
        return this.flush();
    }

    /** 等待写队列排空（受写失败闸门约束：写失败后不再自动重试，由 close 兜底）。 */
    async _drainAll() {
        while (this._queue.length > 0) {
            if (this.writeFailedReason) return;
            if (!this._drainTask) {
                if (!this.active || this.closed) return;
                this._kickDrainer();
            }
            await this._drainTask;
        }
    }

    /** 强制一次最终同步（排空写队列、取消挂起的批量定时器并立即落盘）。 */
    async flush() {
        if (this._syncTimer) {
            this.clock.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
        await this._drainAll();
        if (!this.active) {
            this._dirty = false;
            return false;
        }
        await io.fdatasync(this.active.fd);
        // 仅在同步成功后才清除脏标记，失败的数据保持可重试。
        this._dirty = false;
        return true;
    }

    async _rotateIfDue() {
        if (!this.active) return;
        const bySize = this.active.bytes >= this.segmentMaxBytes;
        const byAge = this.clock.now() - this.active.createdAtMs >= this.segmentMaxAgeMs;
        if (bySize || byAge) await this.sealActiveSegment(bySize ? "size" : "time");
    }

    /**
     * 封存活动段：先落盘并关闭 .part，再压缩为 .gz（临时文件 → fdatasync → 原子改名），
     * 改名成功后才删除原始 .part；任何一步失败都保留原始段并恢复可写状态。
     * 注入配额管理器时，压缩临时文件创建前按"封口前段大小"预留空间，压缩成功后
     * 以 .gz 实际大小 reconcile 校正；预留被拒绝时中止封存并转入安全停止（不抛出）。
     * @param {string} reason 封存原因（"size" | "time" | "manual" | "close" 等）
     * @returns {Promise<object|null>} 封存条目；配额拒绝中止封存时为 null
     */
    async sealActiveSegment(reason = "manual") {
        if (!this.active) return null;
        const segment = this.active;
        await this.flush();
        await closeFd(segment.fd);
        this.active = null;
        const gzFile = `${segment.name}.ndjson.gz`;
        const gzPath = path.join(this.sessionDir, gzFile);
        const tmpPath = `${gzPath}.tmp`;
        if (this.quota) {
            const reserved = await this._reserveQuota(segment.bytes);
            if (!reserved) {
                // 配额拒绝：恢复活动段并转入安全停止，原始段数据保持原样。
                try {
                    segment.fd = await openFd(segment.filePath, "a");
                    this.active = segment;
                } catch {
                    // 重开失败：保持活动段为空，由调用方走恢复流程。
                }
                return null;
            }
        }
        try {
            await gzipFileTo(segment.filePath, tmpPath);
            await io.rename(tmpPath, gzPath);
        } catch (error) {
            try {
                await fsp.unlink(tmpPath);
            } catch {
                // 临时文件不存在或已清理。
            }
            // 封存失败：恢复活动段，采样可以继续写入同一段；重开失败不掩盖原始封存错误。
            try {
                segment.fd = await openFd(segment.filePath, "a");
                this.active = segment;
            } catch {
                // 重开失败：保持活动段为空，由调用方走恢复流程。
            }
            this.recordError("seal-failed", error);
            throw error;
        }
        await fsp.unlink(segment.filePath);
        const stat = await fsp.stat(gzPath);
        const sealedAtMs = this.clock.now();
        const entry = {
            name: segment.name,
            file: gzFile,
            samples: segment.samples,
            bytes: segment.bytes,
            compressedBytes: stat.size,
            sealedAtMs,
            // 段时间边界（导出分段选择用）：startedAtMs 取段创建时刻（≤ 首行 ts，保守纳入），
            // endedAtMs 取封口时刻（≥ 末行 ts，保守纳入）；恢复重建的段缺边界时由导出侧保守纳入。
            startedAtMs: segment.createdAtMs != null ? segment.createdAtMs : null,
            endedAtMs: sealedAtMs,
            reason
        };
        this.manifest.segments.push(entry);
        this.manifest.activeSegment = null;
        this.manifest.quota.usedBytes = (this.manifest.quota.usedBytes || 0) + segment.bytes;
        await writeManifest(this.sessionDir, this.manifest);
        if (this.quota) {
            // 压缩成功后以磁盘实际用量（.gz 实际大小）校正统计；失败不影响封存结果。
            try {
                await this.quota.reconcile(this.sessionDir);
            } catch {
                // 校正失败由后续 reserve 的磁盘基准兜底。
            }
        }
        return entry;
    }

    /**
     * 原子段轮换（在线导出用）：在段状态锁内封存当前活动段并立即开启新段。
     * 旋转期间到达的新样本被段状态锁与写队列暂存，新段就绪后才恢复写入（照常进入新段）；
     * 封存失败时 sealActiveSegment 已回退原段（采样不丢失、错误记 manifest），错误向上抛出；
     * 新段开启被配额拒绝时保留封存结果并返回 opened:false（会话转入安全停止路径）。
     * @param {string} reason 封存原因（默认 "export"）
     * @returns {Promise<{sealed: any, opened: boolean, hadActive: boolean}>}
     *   sealed 为封存条目（含 sealedAtMs，可作一致性截止点）；无活动段时 sealed 为 null
     */
    async rotateSegment(reason = "export") {
        const result = { sealed: null, opened: false, hadActive: false };
        await this._withSegmentLock(async () => {
            if (this.closed) return;
            result.hadActive = Boolean(this.active);
            if (!this.active) return;
            const sealed = await this.sealActiveSegment(reason);
            if (!sealed) return; // 配额拒绝中止封存：原段已回退，保持可写
            result.sealed = sealed;
            if (this.closed || this.quotaStopReason) return;
            result.opened = await this._openNewSegment();
        });
        return result;
    }

    /** 记录一条错误日志到 manifest（最多保留最近 100 条）。 */
    recordError(code, error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!Array.isArray(this.manifest.errors)) this.manifest.errors = [];
        this.manifest.errors.push({ atMs: this.clock.now(), code, message });
        if (this.manifest.errors.length > 100) {
            this.manifest.errors.splice(0, this.manifest.errors.length - 100);
        }
    }

    /** 合并补丁并原子写回 manifest；写盘失败时回滚内存状态。 */
    async updateManifest(patch = {}) {
        this._ensureOpen();
        const backup = { ...this.manifest };
        Object.assign(this.manifest, patch);
        try {
            await writeManifest(this.sessionDir, this.manifest);
        } catch (error) {
            this.manifest = backup;
            throw error;
        }
        return this.manifest;
    }

    /**
     * 关闭会话。"completed" 会封存活动段；其他状态（如 "interrupted"）保留 .part
     * 以便后续 openSession/recoverSession 续录。始终先做一次最终排空尝试
     * （尽力写完队列剩余数据）并强制最终同步。
     */
    async close({ status = "completed" } = {}) {
        if (this.closed) return;
        if (this._syncTimer) {
            this.clock.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
        try {
            // 最终排空：尽力写完写队列中剩余的行；写失败时显式记录丢失数量。
            await this._finalDrainAttempt();
            if (this.active) {
                await this.flush();
                if (status === "completed") {
                    const sealed = await this.sealActiveSegment("close");
                    if (!sealed && this.active) {
                        // 封存被配额拒绝中止：转为中断语义，保留 .part 以便续录。
                        status = "interrupted";
                        const segment = this.active;
                        await closeFd(segment.fd);
                        this.active = null;
                        this.manifest.activeSegment = {
                            name: segment.name,
                            file: segment.file,
                            createdAtMs: segment.createdAtMs,
                            samples: segment.samples,
                            bytes: segment.bytes
                        };
                    }
                } else {
                    const segment = this.active;
                    await closeFd(segment.fd);
                    this.active = null;
                    this.manifest.activeSegment = {
                        name: segment.name,
                        file: segment.file,
                        createdAtMs: segment.createdAtMs,
                        samples: segment.samples,
                        bytes: segment.bytes
                    };
                }
            }
            this.manifest.status = status;
            this.manifest.endedAtMs = this.clock.now();
            await writeManifest(this.sessionDir, this.manifest);
        } catch (error) {
            // 仅在所有持久化成功后才标记关闭；失败时关闭活动 fd 防止泄漏，
            // 保留 .part 与未关闭语义，调用方可以重试或走恢复流程。
            if (this.active) {
                try {
                    await closeFd(this.active.fd);
                } catch {
                    // fd 关闭失败不掩盖原始错误。
                }
                this.active = null;
            }
            this.recordError("close-failed", error);
            throw error;
        }
        this.closed = true;
    }
}

/**
 * 创建新录制会话：建目录、写初始 manifest 并打开第一个活动段。
 * @param {object} options
 * @param {string} [options.storageRoot] 存储根目录（如扩展 globalStorage 目录）；缺失时抛出
 * @param {string} [options.workspacePath] 工作区路径（用于计算哈希）
 * @param {string} [options.workspaceHash] 预计算的工作区哈希
 * @param {string} [options.recordingId] 省略时自动生成
 * @param {Array<{name: string, type?: string, address?: string}>} [options.fixedVariables]
 * @param {number} [options.targetIntervalMs]
 * @param {string} [options.elfSha256]
 * @param {string} [options.mcuId]
 * @param {string} [options.debuggerId]
 * @param {{maxMiB?: number, globalMaxMiB?: number}} [options.limits]
 * @param {RecordingClock} [options.clock] 可注入时钟 {now, setTimeout, clearTimeout}
 * @param {object} [options.quota] 可注入的配额管理器（createQuotaManager 返回值）；省略时不限配额
 * @param {Function} [options.onQuotaExceeded] 配额拒绝回调 (reason, result) => Promise|void，
 *   供上层把会话置为 "stopped-quota" 等安全停止状态
 * @param {Function} [options.onWriteError] 写失败回调 (error) => void，
 *   供上层把会话置为 "stopped-error" 等安全停止状态
 * @param {number} [options.segmentMaxBytes] 测试用覆盖，默认 32 MiB
 * @param {number} [options.segmentMaxAgeMs] 测试用覆盖，默认 5 分钟
 * @param {number} [options.syncIntervalMs] 测试用覆盖，默认 1000
 * @param {number} [options.writeQueueHighWatermarkBytes] 测试用覆盖，默认 8 MiB
 * @param {number} [options.writeQueueHardMaxBytes] 测试用覆盖，默认 16 MiB
 * @param {number} [options.writeQueueLowWatermarkBytes] 测试用覆盖，默认 4 MiB
 * @returns {Promise<RecordingSession>}
 */
async function createSession(options = {}) {
    if (!options.storageRoot) throw new Error("storageRoot is required");
    const clock = options.clock || defaultClock;
    const wsHash = options.workspaceHash || (options.workspacePath ? workspaceHash(options.workspacePath) : null);
    if (!wsHash) throw new Error("workspacePath or workspaceHash is required");
    const recordingId = options.recordingId || nextRecordingId(clock.now());
    const sessionDir = sessionDirFor(options.storageRoot, wsHash, recordingId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const limits = resolveRecordingLimits(options.limits || {});
    const startedAtMs = clock.now();
    const manifest = {
        formatVersion: FORMAT_VERSION,
        status: "recording",
        createdAtMs: startedAtMs,
        startedAtMs,
        endedAtMs: null,
        fixedVariables: (options.fixedVariables || []).map((variable) => ({
            name: variable.name,
            type: variable.type ?? null,
            address: variable.address ?? null
        })),
        elfSha256: options.elfSha256 ?? null,
        mcuId: options.mcuId ?? null,
        debuggerId: options.debuggerId ?? null,
        targetIntervalMs: options.targetIntervalMs ?? null,
        sequenceCounter: 0,
        segments: [],
        activeSegment: null,
        errors: [],
        quota: { maxMiB: limits.maxMiB, globalMaxMiB: limits.globalMaxMiB, usedBytes: 0 }
    };
    await writeManifest(sessionDir, manifest);
    const session = new RecordingSession({
        sessionDir,
        manifest,
        clock,
        segmentMaxBytes: options.segmentMaxBytes,
        segmentMaxAgeMs: options.segmentMaxAgeMs,
        syncIntervalMs: options.syncIntervalMs,
        quota: options.quota || null,
        onQuotaExceeded: options.onQuotaExceeded || null,
        onWriteError: options.onWriteError || null,
        writeQueueHighWatermarkBytes: options.writeQueueHighWatermarkBytes,
        writeQueueHardMaxBytes: options.writeQueueHardMaxBytes,
        writeQueueLowWatermarkBytes: options.writeQueueLowWatermarkBytes
    });
    await session._openNewSegment();
    return session;
}

/**
 * 恢复后 manifest 的最小读取形状（磁盘 JSON 文档，字段可能缺失或由旧版本写入）。
 * @typedef {object} RecoveredSessionManifest
 * @property {{name: string, file: string, createdAtMs: number|null, samples: number, bytes: number}|null} [activeSegment] 活动段（续录在其 .part 后追加）
 */

/**
 * 恢复一个可能中断的会话目录：
 *   - 清理残留的 *.tmp 临时文件；
 *   - 对已有封存 .gz 的同索引陈旧 .part（rename 成功但 unlink 前崩溃的窗口）只保留 .gz；
 *   - 截断 .part 中不完整的尾行（定位最后一个 \n 并在其后截断）；
 *   - 从存活行重算序号计数器；
 *   - 按磁盘文件重建段列表，原子写回修复后的 manifest（状态置为 "interrupted"）；
 *   - 损坏/不可解析的 manifest.json 视同缺失，从磁盘重建。
 * @param {{sessionDir?: string, storageRoot?: string, workspacePath?: string, workspaceHash?: string,
 *          recordingId?: string, clock?: RecordingClock}} options
 * @returns {Promise<{sessionDir: string, hadManifest: boolean, truncated: boolean, truncatedBytes: number,
 *          recoveredLines: number, sequenceCounter: number, partFiles: string[], staleParts: string[],
 *          segments: object[], manifest: RecoveredSessionManifest}>}
 */
async function recoverSession(options = {}) {
    const clock = options.clock || defaultClock;
    let sessionDir = options.sessionDir;
    if (!sessionDir) {
        const wsHash = options.workspaceHash || workspaceHash(options.workspacePath);
        sessionDir = sessionDirFor(options.storageRoot, wsHash, options.recordingId);
    }
    let existing = null;
    try {
        existing = await readManifest(sessionDir);
    } catch {
        // 损坏/不可解析的 manifest 视同缺失，从磁盘文件重建。
        existing = null;
    }
    const report = {
        sessionDir,
        hadManifest: Boolean(existing),
        truncated: false,
        truncatedBytes: 0,
        recoveredLines: 0,
        sequenceCounter: existing && Number.isInteger(existing.sequenceCounter) ? existing.sequenceCounter : 0,
        partFiles: [],
        staleParts: [],
        segments: [],
        // 返回前写入重建/修复后的 manifest（见 @returns 契约）。
        manifest: null
    };
    const entries = await fsp.readdir(sessionDir);
    // 清理上次原子写入崩溃残留的临时文件。
    for (const entry of entries.filter((name) => name.endsWith(".tmp"))) {
        try {
            await fsp.unlink(path.join(sessionDir, entry));
        } catch {
            // 清理失败不阻塞恢复。
        }
    }
    const gzFiles = entries.filter((entry) => entry.endsWith(".ndjson.gz")).sort();
    const sealedFiles = new Set(gzFiles);
    const partFiles = [];
    for (const entry of entries.filter((entry) => entry.endsWith(".ndjson.part")).sort()) {
        // rename 成功但 .part 尚未删除的崩溃窗口：保留封存 .gz，删除陈旧 .part，
        // 确保每个段索引至多一个数据源，且不把陈旧 .part 当作活动段。
        const sealedSibling = `${entry.slice(0, -".ndjson.part".length)}.ndjson.gz`;
        if (sealedFiles.has(sealedSibling)) {
            try {
                await fsp.unlink(path.join(sessionDir, entry));
                report.staleParts.push(entry);
            } catch {
                // 删除失败时退回常规 .part 处理，避免数据丢失。
                partFiles.push(entry);
            }
            continue;
        }
        partFiles.push(entry);
    }
    const known = new Map();
    for (const segment of existing && Array.isArray(existing.segments) ? existing.segments : []) {
        if (segment && segment.file) known.set(segment.file, segment);
    }
    for (const gzFile of gzFiles) {
        let segment = known.get(gzFile);
        if (!segment) {
            const stat = await fsp.stat(path.join(sessionDir, gzFile));
            segment = {
                name: gzFile.slice(0, -".ndjson.gz".length),
                file: gzFile,
                samples: null,
                bytes: null,
                compressedBytes: stat.size,
                sealedAtMs: null,
                reason: "recovered"
            };
        }
        report.segments.push(segment);
    }
    let lastPart = null;
    for (const partFile of partFiles) {
        const partPath = path.join(sessionDir, partFile);
        const buffer = await fsp.readFile(partPath);
        let end = buffer.length;
        if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
            end = buffer.lastIndexOf(0x0a) + 1; // 无换行符时为 0，整段视为未完成行
        }
        if (end < buffer.length) {
            await fsp.truncate(partPath, end);
            report.truncated = true;
            report.truncatedBytes += buffer.length - end;
        }
        for (const line of buffer.slice(0, end).toString("utf8").split("\n")) {
            if (!line) continue;
            try {
                const parsed = JSON.parse(line);
                report.recoveredLines += 1;
                if (Number.isInteger(parsed.seq)) report.sequenceCounter = Math.max(report.sequenceCounter, parsed.seq);
            } catch {
                // 完整行仍解析失败：保留在文件中等待人工检查，不计入恢复统计。
            }
        }
        report.partFiles.push(partFile);
        lastPart = partFile;
    }
    const manifest = existing ? { ...existing } : {};
    manifest.formatVersion = FORMAT_VERSION;
    manifest.status = existing && existing.status === "completed" ? "completed" : "interrupted";
    manifest.endedAtMs = existing && existing.endedAtMs != null ? existing.endedAtMs : clock.now();
    manifest.fixedVariables = Array.isArray(manifest.fixedVariables) ? manifest.fixedVariables : [];
    manifest.segments = report.segments;
    manifest.sequenceCounter = report.sequenceCounter;
    manifest.errors = Array.isArray(manifest.errors) ? [...manifest.errors] : [];
    manifest.errors.push({
        atMs: clock.now(),
        code: "session-recovered",
        message: `recovered ${report.recoveredLines} lines, truncated ${report.truncatedBytes} bytes, manifest present: ${report.hadManifest}`
    });
    if (manifest.errors.length > 100) manifest.errors.splice(0, manifest.errors.length - 100);
    if (lastPart) {
        const stat = await fsp.stat(path.join(sessionDir, lastPart));
        manifest.activeSegment = {
            name: lastPart.slice(0, -".ndjson.part".length),
            file: lastPart,
            createdAtMs: existing && existing.activeSegment ? (existing.activeSegment.createdAtMs ?? null) : null,
            samples: report.recoveredLines,
            bytes: stat.size
        };
    } else {
        manifest.activeSegment = null;
    }
    if (!manifest.quota || typeof manifest.quota !== "object") {
        const limits = resolveRecordingLimits({});
        manifest.quota = { maxMiB: limits.maxMiB, globalMaxMiB: limits.globalMaxMiB, usedBytes: 0 };
    }
    await writeManifest(sessionDir, manifest);
    report.manifest = manifest;
    return report;
}

/**
 * 打开既有会话（先执行恢复流程），重新以追加模式打开活动段，可继续写入。
 * 选项与 recoverSession 相同，另支持 RecordingSession 的覆盖参数
 * （含可选的 quota 配额管理器与 onQuotaExceeded 回调注入）。
 * @returns {Promise<RecordingSession>}
 */
async function openSession(options = {}) {
    const report = await recoverSession(options);
    const session = new RecordingSession({
        sessionDir: report.sessionDir,
        manifest: report.manifest,
        clock: options.clock || defaultClock,
        segmentMaxBytes: options.segmentMaxBytes,
        segmentMaxAgeMs: options.segmentMaxAgeMs,
        syncIntervalMs: options.syncIntervalMs,
        quota: options.quota || null,
        onQuotaExceeded: options.onQuotaExceeded || null,
        onWriteError: options.onWriteError || null,
        writeQueueHighWatermarkBytes: options.writeQueueHighWatermarkBytes,
        writeQueueHardMaxBytes: options.writeQueueHardMaxBytes,
        writeQueueLowWatermarkBytes: options.writeQueueLowWatermarkBytes
    });
    if (report.manifest.activeSegment) {
        const file = report.manifest.activeSegment.file;
        const filePath = path.join(report.sessionDir, file);
        const stat = await fsp.stat(filePath);
        session.active = {
            name: report.manifest.activeSegment.name,
            file,
            filePath,
            fd: await openFd(filePath, "a"),
            samples: report.manifest.activeSegment.samples || 0,
            bytes: stat.size,
            createdAtMs: report.manifest.activeSegment.createdAtMs || session.clock.now()
        };
    }
    return session;
}

/** 固定时长的真实睡眠，用于跨进程锁重试；不依赖注入时钟，避免假时钟下死等。 */
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 递归统计目录实际磁盘占用（字节）；目录不存在按 0 处理，单个文件消失不计入。 */
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

/**
 * 跨进程录制配额管理器（由 createQuotaManager 创建，不要直接 new）。
 *
 * 全局统计以磁盘为准：实例首次进入加锁临界区时扫描存储根下各工作区目录中的
 * *.eprec 会话目录的实际大小建立基线，之后在锁内增量维护；进程崩溃后新实例
 * 自动从磁盘重建，绝不依赖内存中的陈旧值。所有全局统计的修改都在
 * <storageRoot>/quota.lock 的 wx 独占锁内完成，拿不到锁时按 50ms × 20 次
 * 短暂重试，仍失败则返回 quota-lock-busy，绝不死等或死锁。
 */
class RecordingQuotaManager {
    constructor({ storageRoot, maxBytes, globalMaxBytes, clock }) {
        this.storageRoot = storageRoot;
        this.maxBytes = maxBytes;
        this.globalMaxBytes = globalMaxBytes;
        this.clock = clock;
        this._lockPath = path.join(storageRoot, QUOTA_LOCK_FILE);
        this._initialized = false;
        this._sessions = new Map(); // 绝对会话目录 → 已预留/实际字节
        this._perWorkspace = new Map(); // 工作区哈希 → 字节
        this._global = 0;
    }

    /** 会话目录所属的工作区键（storageRoot 下的第一级目录，即工作区哈希）。 */
    _workspaceKeyFor(sessionDir) {
        const relative = path.relative(this.storageRoot, sessionDir);
        if (!relative || relative.startsWith("..")) return path.basename(sessionDir);
        return relative.split(path.sep)[0] || path.basename(sessionDir);
    }

    _usageSnapshot(sessionDir, sessionBytes = this._sessions.get(sessionDir) || 0) {
        return {
            sessionDir,
            sessionBytes,
            globalBytes: this._global,
            maxBytes: this.maxBytes,
            globalMaxBytes: this.globalMaxBytes
        };
    }

    /** 扫描存储根下各工作区目录中 *.eprec 会话目录的实际大小，产出全局统计基线。 */
    async _scanDiskBaseline() {
        const sessions = new Map();
        const perWorkspace = new Map();
        let global = 0;
        let workspaceEntries = [];
        try {
            workspaceEntries = await fsp.readdir(this.storageRoot, { withFileTypes: true });
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        for (const workspaceEntry of workspaceEntries) {
            if (!workspaceEntry.isDirectory()) continue;
            const workspaceDir = path.join(this.storageRoot, workspaceEntry.name);
            let sessionEntries = [];
            try {
                sessionEntries = await fsp.readdir(workspaceDir, { withFileTypes: true });
            } catch {
                // 工作区目录读取失败：跳过，不阻塞其余目录的统计。
                continue;
            }
            for (const sessionEntry of sessionEntries) {
                if (!sessionEntry.isDirectory() || !sessionEntry.name.endsWith(".eprec")) continue;
                const dir = path.join(workspaceDir, sessionEntry.name);
                const bytes = await directorySizeBytes(dir);
                sessions.set(dir, bytes);
                perWorkspace.set(workspaceEntry.name, (perWorkspace.get(workspaceEntry.name) || 0) + bytes);
                global += bytes;
            }
        }
        return { sessions, perWorkspace, global };
    }

    /** 惰性初始化：仅在本实例尚未建立基线时扫描磁盘；并发路径下后完成者让步。 */
    async _ensureInitialized() {
        if (this._initialized) return;
        const baseline = await this._scanDiskBaseline();
        if (this._initialized) return; // 另一个并发路径已完成初始化
        this._sessions = baseline.sessions;
        this._perWorkspace = baseline.perWorkspace;
        this._global = baseline.global;
        this._initialized = true;
    }

    /** 读取某会话的统计；基线之后新建的会话按磁盘实际用量登记。 */
    async _trackedSessionUsage(sessionDir) {
        const known = this._sessions.get(sessionDir);
        if (known !== undefined) return known;
        const bytes = await directorySizeBytes(sessionDir);
        this._sessions.set(sessionDir, bytes);
        const workspaceKey = this._workspaceKeyFor(sessionDir);
        this._perWorkspace.set(workspaceKey, (this._perWorkspace.get(workspaceKey) || 0) + bytes);
        this._global += bytes;
        return bytes;
    }

    /** 在全局统计上累加预留字节。 */
    _addReserved(sessionDir, bytes) {
        this._sessions.set(sessionDir, (this._sessions.get(sessionDir) || 0) + bytes);
        const workspaceKey = this._workspaceKeyFor(sessionDir);
        this._perWorkspace.set(workspaceKey, (this._perWorkspace.get(workspaceKey) || 0) + bytes);
        this._global += bytes;
    }

    /**
     * 获取跨进程锁（quota.lock 的 wx 独占创建）。
     * 锁文件 mtime 超过 QUOTA_LOCK_STALE_MS 视为陈旧并接管；拿不到时按
     * 50ms × QUOTA_LOCK_RETRY_LIMIT 短暂重试。
     * @returns {Promise<Function|null>} 释放函数；null 表示锁繁忙
     * @throws {Error} 存储根不可写等基础设施故障（调用方须转为错误对象）
     */
    async _acquireLock() {
        for (let attempt = 0; attempt < QUOTA_LOCK_RETRY_LIMIT; attempt += 1) {
            if (attempt > 0) await sleepMs(QUOTA_LOCK_RETRY_MS);
            const token = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
            let handle;
            try {
                handle = await fsp.open(this._lockPath, "wx");
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                // 锁被占用：mtime 超时视为陈旧锁并接管，否则稍后重试。
                let stale = false;
                try {
                    const stat = await fsp.stat(this._lockPath);
                    stale = this.clock.now() - stat.mtimeMs > QUOTA_LOCK_STALE_MS;
                } catch {
                    continue; // 锁刚好被持有者释放，直接重试。
                }
                if (stale) {
                    try {
                        await fsp.unlink(this._lockPath);
                    } catch {
                        continue; // 接管失败（他人已接管），重试。
                    }
                }
                continue;
            }
            try {
                await handle.writeFile(`${token}\n`, "utf8");
            } finally {
                await handle.close();
            }
            let released = false;
            return async () => {
                if (released) return;
                released = true;
                try {
                    // 仅当锁仍由本实例持有时才删除，避免误删接管者的新锁。
                    const current = await fsp.readFile(this._lockPath, "utf8");
                    if (current.trim() === token) await fsp.unlink(this._lockPath);
                } catch {
                    // 释放失败不影响主流程（陈旧锁检测会兜底）。
                }
            };
        }
        return null;
    }

    /** 在跨进程锁内执行全局统计的修改；返回 null 表示锁繁忙。 */
    async _withLock(action) {
        const release = await this._acquireLock();
        if (!release) return null;
        try {
            await this._ensureInitialized();
            return await action();
        } finally {
            await release();
        }
    }

    /**
     * 为某会话预留 bytes 字节。会话用量 + 请求字节超过单会话上限，或全局用量 +
     * 请求字节超过全局上限时拒绝；拒绝不影响任何已写入数据（绝不截断、绝不循环覆盖）。
     * @returns {Promise<{ok: boolean, granted?: number, reason?: string, usage?: object, error?: string}>}
     */
    async reserve(sessionDir, bytes) {
        const dir = path.resolve(sessionDir);
        if (!Number.isFinite(bytes) || bytes < 0) {
            return { ok: false, reason: "quota-invalid-request", usage: this._usageSnapshot(dir) };
        }
        try {
            const result = await this._withLock(async () => {
                const used = await this._trackedSessionUsage(dir);
                if (used + bytes > this.maxBytes) {
                    return { ok: false, reason: "session-quota-exceeded", usage: this._usageSnapshot(dir) };
                }
                if (this._global + bytes > this.globalMaxBytes) {
                    return { ok: false, reason: "global-quota-exceeded", usage: this._usageSnapshot(dir) };
                }
                this._addReserved(dir, bytes);
                return { ok: true, granted: bytes, usage: this._usageSnapshot(dir) };
            });
            if (result) return result;
            return { ok: false, reason: "quota-lock-busy", usage: this._usageSnapshot(dir) };
        } catch (error) {
            // 存储根不可写等基础设施故障以错误对象返回，绝不向写入路径抛出未处理异常。
            return { ok: false, reason: "quota-unavailable", error: error.message, usage: this._usageSnapshot(dir) };
        }
    }

    /** 归还某会话的预留（会话结束/封存后按实际用量校正）。 */
    async release(sessionDir, bytes) {
        const dir = path.resolve(sessionDir);
        if (!Number.isFinite(bytes) || bytes < 0) {
            return { ok: false, reason: "quota-invalid-request", usage: this._usageSnapshot(dir) };
        }
        try {
            const result = await this._withLock(async () => {
                const tracked = this._sessions.get(dir);
                if (tracked !== undefined && bytes > 0) {
                    const reduced = Math.max(0, tracked - bytes);
                    const delta = tracked - reduced;
                    this._sessions.set(dir, reduced);
                    const workspaceKey = this._workspaceKeyFor(dir);
                    this._perWorkspace.set(
                        workspaceKey,
                        Math.max(0, (this._perWorkspace.get(workspaceKey) || 0) - delta)
                    );
                    this._global = Math.max(0, this._global - delta);
                }
                return { ok: true, usage: this._usageSnapshot(dir) };
            });
            if (result) return result;
            return { ok: false, reason: "quota-lock-busy", usage: this._usageSnapshot(dir) };
        } catch (error) {
            return { ok: false, reason: "quota-unavailable", error: error.message, usage: this._usageSnapshot(dir) };
        }
    }

    /** 以实际磁盘用量校正某会话的统计（封存压缩后调用，磁盘为唯一事实来源）。 */
    async reconcile(sessionDir) {
        const dir = path.resolve(sessionDir);
        try {
            const result = await this._withLock(async () => {
                const known = this._sessions.get(dir);
                const actual = await directorySizeBytes(dir);
                if (known === undefined) {
                    // 基线建立后才出现的会话：直接登记实际用量。
                    this._sessions.set(dir, actual);
                    const workspaceKey = this._workspaceKeyFor(dir);
                    this._perWorkspace.set(workspaceKey, (this._perWorkspace.get(workspaceKey) || 0) + actual);
                    this._global += actual;
                } else if (actual !== known) {
                    const delta = actual - known;
                    this._sessions.set(dir, actual);
                    const workspaceKey = this._workspaceKeyFor(dir);
                    this._perWorkspace.set(
                        workspaceKey,
                        Math.max(0, (this._perWorkspace.get(workspaceKey) || 0) + delta)
                    );
                    this._global = Math.max(0, this._global + delta);
                }
                return { ok: true, bytes: actual, usage: this._usageSnapshot(dir, actual) };
            });
            if (result) return result;
            return { ok: false, reason: "quota-lock-busy", usage: this._usageSnapshot(dir) };
        } catch (error) {
            return { ok: false, reason: "quota-unavailable", error: error.message, usage: this._usageSnapshot(dir) };
        }
    }

    /** 快照：{ perWorkspace: {wsHash: bytes}, global: bytes, limits: {maxBytes, globalMaxBytes} } */
    async stats() {
        await this._ensureInitialized();
        return {
            perWorkspace: Object.fromEntries(this._perWorkspace),
            global: this._global,
            limits: { maxBytes: this.maxBytes, globalMaxBytes: this.globalMaxBytes }
        };
    }

    /** 判断某会话是否还能写入：返回 {allowed: boolean, reason?: string}。 */
    async check(sessionDir) {
        const dir = path.resolve(sessionDir);
        try {
            await this._ensureInitialized();
            const sessionBytes = this._sessions.has(dir) ? this._sessions.get(dir) : await directorySizeBytes(dir);
            if (sessionBytes >= this.maxBytes) {
                return {
                    allowed: false,
                    reason: "session-quota-exceeded",
                    usage: this._usageSnapshot(dir, sessionBytes)
                };
            }
            if (this._global >= this.globalMaxBytes) {
                return {
                    allowed: false,
                    reason: "global-quota-exceeded",
                    usage: this._usageSnapshot(dir, sessionBytes)
                };
            }
            return { allowed: true, usage: this._usageSnapshot(dir, sessionBytes) };
        } catch (error) {
            return { allowed: false, reason: "quota-unavailable", error: error.message };
        }
    }
}

/**
 * 创建跨进程录制配额管理器。
 * @param {{storageRoot?: string, maxMiB?: number, globalMaxMiB?: number, clock?: RecordingClock, now?: Function}} options
 *   storageRoot 必填（缺失时抛出）；maxMiB/globalMaxMiB 经 resolveRecordingLimits 收敛
 *   （默认 1024/2048，即 1 GiB / 2 GiB）；clock/now 仅作为陈旧锁检测的时间源，省略时使用系统时钟。
 * @returns {RecordingQuotaManager}
 */
function createQuotaManager(options = {}) {
    if (!options.storageRoot) throw new Error("storageRoot is required");
    const clock =
        options.clock || (typeof options.now === "function" ? { ...defaultClock, now: options.now } : defaultClock);
    const limits = resolveRecordingLimits({ maxMiB: options.maxMiB, globalMaxMiB: options.globalMaxMiB });
    return new RecordingQuotaManager({
        storageRoot: path.resolve(options.storageRoot),
        maxBytes: limits.maxMiB * BYTES_PER_MIB,
        globalMaxBytes: limits.globalMaxMiB * BYTES_PER_MIB,
        clock
    });
}

module.exports = {
    FORMAT_VERSION,
    MANIFEST_FILE,
    SEGMENT_MAX_AGE_MS,
    SEGMENT_MAX_BYTES,
    SYNC_INTERVAL_MS,
    WRITE_QUEUE_HIGH_WATERMARK_BYTES,
    WRITE_QUEUE_HARD_MAX_BYTES,
    WRITE_QUEUE_LOW_WATERMARK_BYTES,
    QUOTA_LOCK_FILE,
    QUOTA_LOCK_STALE_MS,
    RecordingSession,
    RecordingQuotaManager,
    createSession,
    openSession,
    recoverSession,
    createQuotaManager,
    readManifest,
    resolveRecordingLimits,
    sessionDirFor,
    workspaceHash,
    nextRecordingId,
    _io: io
};

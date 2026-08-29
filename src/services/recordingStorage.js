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
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");

const fsp = fs.promises;

// fs.promises 没有裸 fd 的 fdatasync；用回调版包装，并通过自有对象引用，
// 使测试可以观测/注入 fdatasync 与 rename。
const io = {
    fdatasync: (fd) =>
        new Promise((resolve, reject) => {
            fs.fdatasync(fd, (error) => (error ? reject(error) : resolve()));
        }),
    rename: (from, to) => fsp.rename(from, to)
};

const FORMAT_VERSION = 1;
const MANIFEST_FILE = "manifest.json";
const SEGMENT_MAX_AGE_MS = 5 * 60 * 1000;
const SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const SYNC_INTERVAL_MS = 1000;
const MAX_MIB_LIMITS = { min: 64, max: 102400, fallback: 1024 };
const GLOBAL_MAX_MIB_LIMITS = { min: 128, max: 204800, fallback: 2048 };

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
    const stamp = new Date(nowMs).toISOString().replace(/[-:T]/g, "").slice(0, 15);
    return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

function openFd(filePath, flags) {
    return new Promise((resolve, reject) => {
        fs.open(filePath, flags, (error, fd) => (error ? reject(error) : resolve(fd)));
    });
}

function closeFd(fd) {
    return new Promise((resolve, reject) => {
        fs.close(fd, (error) => (error ? reject(error) : resolve()));
    });
}

function writeFd(fd, buffer) {
    return new Promise((resolve, reject) => {
        fs.write(fd, buffer, 0, buffer.length, (error) => (error ? reject(error) : resolve()));
    });
}

/** 原子写文件：同目录临时文件 → fdatasync → rename 覆盖，失败时清理临时文件。 */
async function atomicWriteFile(dir, name, buffer) {
    const tmpPath = path.join(dir, `${name}.tmp`);
    const fd = await openFd(tmpPath, "w");
    try {
        await writeFd(fd, buffer);
        await io.fdatasync(fd);
    } finally {
        await closeFd(fd);
    }
    try {
        await io.rename(tmpPath, path.join(dir, name));
    } catch (error) {
        try {
            await fsp.unlink(tmpPath);
        } catch {
            // 临时文件清理失败不掩盖原始错误。
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
        syncIntervalMs = SYNC_INTERVAL_MS
    }) {
        this.sessionDir = sessionDir;
        this.manifest = manifest;
        this.clock = clock;
        this.segmentMaxBytes = segmentMaxBytes;
        this.segmentMaxAgeMs = segmentMaxAgeMs;
        this.syncIntervalMs = syncIntervalMs;
        this.active = null;
        this.closed = false;
        this._dirty = false;
        this._syncTimer = null;
    }

    /** 活动段 .part 文件绝对路径；无活动段时为 null。 */
    get activeFilePath() {
        return this.active ? this.active.filePath : null;
    }

    _ensureOpen() {
        if (this.closed) throw new Error("recording session is closed");
    }

    async _openNewSegment() {
        const name = `seg-${String(this.manifest.segments.length + 1).padStart(6, "0")}`;
        const file = `${name}.ndjson.part`;
        const filePath = path.join(this.sessionDir, file);
        const fd = await openFd(filePath, "a");
        this.active = { name, file, filePath, fd, samples: 0, bytes: 0, createdAtMs: this.clock.now() };
        this.manifest.activeSegment = { name, file, createdAtMs: this.active.createdAtMs, samples: 0, bytes: 0 };
        await writeManifest(this.sessionDir, this.manifest);
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
     * 追加一条采样行。自动分配递增序号，写入活动段并合并 1 秒批量同步。
     * @param {{source?: string, full?: boolean, timestampMs?: number, elapsedMs?: number, values?: Array}} sample
     *   values 为固定列的 valueText 数组（按 fixedVariables 顺序），缺失值传 null。
     * @returns {Promise<{seq: number, line: string}>}
     */
    async appendSampleLine(sample) {
        this._ensureOpen();
        await this._rotateIfDue();
        if (!this.active) await this._openNewSegment();
        const seq = this.manifest.sequenceCounter + 1;
        const line = this._buildLine(sample, seq);
        const buffer = Buffer.from(line, "utf8");
        await writeFd(this.active.fd, buffer);
        this.manifest.sequenceCounter = seq;
        this.active.samples += 1;
        this.active.bytes += buffer.length;
        this._markDirty();
        return { seq, line };
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

    /** 强制一次最终同步（取消挂起的批量定时器并立即落盘）。 */
    async flush() {
        if (this._syncTimer) {
            this.clock.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
        this._dirty = false;
        if (!this.active) return false;
        await io.fdatasync(this.active.fd);
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
     * @param {string} reason 封存原因（"size" | "time" | "manual" | "close" 等）
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
        try {
            await gzipFileTo(segment.filePath, tmpPath);
            await io.rename(tmpPath, gzPath);
        } catch (error) {
            try {
                await fsp.unlink(tmpPath);
            } catch {
                // 临时文件不存在或已清理。
            }
            // 封存失败：恢复活动段，采样可以继续写入同一段。
            segment.fd = await openFd(segment.filePath, "a");
            this.active = segment;
            this.recordError("seal-failed", error);
            throw error;
        }
        await fsp.unlink(segment.filePath);
        const stat = await fsp.stat(gzPath);
        const entry = {
            name: segment.name,
            file: gzFile,
            samples: segment.samples,
            bytes: segment.bytes,
            compressedBytes: stat.size,
            sealedAtMs: this.clock.now(),
            reason
        };
        this.manifest.segments.push(entry);
        this.manifest.activeSegment = null;
        this.manifest.quota.usedBytes = (this.manifest.quota.usedBytes || 0) + segment.bytes;
        await writeManifest(this.sessionDir, this.manifest);
        return entry;
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
     * 以便后续 openSession/recoverSession 续录。始终先强制最终同步。
     */
    async close({ status = "completed" } = {}) {
        if (this.closed) return;
        this.closed = true;
        if (this._syncTimer) {
            this.clock.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
        if (this.active) {
            await this.flush();
            if (status === "completed") {
                await this.sealActiveSegment("close");
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
    }
}

/**
 * 创建新录制会话：建目录、写初始 manifest 并打开第一个活动段。
 * @param {object} options
 * @param {string} options.storageRoot 存储根目录（如扩展 globalStorage 目录）
 * @param {string} [options.workspacePath] 工作区路径（用于计算哈希）
 * @param {string} [options.workspaceHash] 预计算的工作区哈希
 * @param {string} [options.recordingId] 省略时自动生成
 * @param {Array<{name: string, type?: string, address?: string}>} [options.fixedVariables]
 * @param {number} [options.targetIntervalMs]
 * @param {string} [options.elfSha256]
 * @param {string} [options.mcuId]
 * @param {string} [options.debuggerId]
 * @param {{maxMiB?: number, globalMaxMiB?: number}} [options.limits]
 * @param {object} [options.clock] 可注入时钟 {now, setTimeout, clearTimeout}
 * @param {number} [options.segmentMaxBytes] 测试用覆盖，默认 32 MiB
 * @param {number} [options.segmentMaxAgeMs] 测试用覆盖，默认 5 分钟
 * @param {number} [options.syncIntervalMs] 测试用覆盖，默认 1000
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
        syncIntervalMs: options.syncIntervalMs
    });
    await session._openNewSegment();
    return session;
}

/**
 * 恢复一个可能中断的会话目录：
 *   - 截断 .part 中不完整的尾行（定位最后一个 \n 并在其后截断）；
 *   - 从存活行重算序号计数器；
 *   - 按磁盘文件重建段列表，原子写回修复后的 manifest（状态置为 "interrupted"）。
 * @param {{sessionDir?: string, storageRoot?: string, workspacePath?: string, workspaceHash?: string,
 *          recordingId?: string, clock?: object}} options
 * @returns {Promise<{sessionDir: string, hadManifest: boolean, truncated: boolean, truncatedBytes: number,
 *          recoveredLines: number, sequenceCounter: number, partFiles: string[], segments: object[],
 *          manifest: object}>}
 */
async function recoverSession(options = {}) {
    const clock = options.clock || defaultClock;
    let sessionDir = options.sessionDir;
    if (!sessionDir) {
        const wsHash = options.workspaceHash || workspaceHash(options.workspacePath);
        sessionDir = sessionDirFor(options.storageRoot, wsHash, options.recordingId);
    }
    const existing = await readManifest(sessionDir);
    const report = {
        sessionDir,
        hadManifest: Boolean(existing),
        truncated: false,
        truncatedBytes: 0,
        recoveredLines: 0,
        sequenceCounter: existing && Number.isInteger(existing.sequenceCounter) ? existing.sequenceCounter : 0,
        partFiles: [],
        segments: []
    };
    const entries = await fsp.readdir(sessionDir);
    const gzFiles = entries.filter((entry) => entry.endsWith(".ndjson.gz")).sort();
    const partFiles = entries.filter((entry) => entry.endsWith(".ndjson.part")).sort();
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
 * 选项与 recoverSession 相同，另支持 RecordingSession 的覆盖参数。
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
        syncIntervalMs: options.syncIntervalMs
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

module.exports = {
    FORMAT_VERSION,
    MANIFEST_FILE,
    SEGMENT_MAX_AGE_MS,
    SEGMENT_MAX_BYTES,
    SYNC_INTERVAL_MS,
    RecordingSession,
    createSession,
    openSession,
    recoverSession,
    readManifest,
    resolveRecordingLimits,
    sessionDirFor,
    workspaceHash,
    nextRecordingId,
    _io: io
};

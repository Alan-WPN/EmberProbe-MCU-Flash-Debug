"use strict";

/**
 * 长录制流式 CSV 导出与清理（扩展宿主持有）。
 *
 * 职责（"超长录制与选择性 CSV 导出"计划第 4 步）：
 *   - 按 manifest 选择与时间范围重叠的分段，流式解压（.gz）→ 按行拆分 → JSON 解析 →
 *     时间/变量筛选 → RFC 4180 CSV 写入；kind:"recording-event" 内部事件行导出时忽略。
 *   - CSV 与现有图表 CSV 一致：表头 time,<variables...>（列序 = 请求顺序）、UTF-8 BOM、
 *     行尾 CRLF、time 列 ISO 8601 UTC、缺失值输出空字段、不输出任何状态行/注释行。
 *   - 原子完成：先写 <outputPath>.partial，写完 fdatasync 并关闭后原子 rename；
 *     取消/失败删除 .partial，目标路径永不出现半成品，内部录制数据不受影响。
 *   - 在线导出（活动会话）：先原子旋转（封存当前段 + 立即开新段）得到一致性截止点，
 *     仅导出已封存段，截止点之后的样本（新段中的）不属于本次导出；活动会话拒绝清理。
 *   - 最终导出清理：停止/配额停止/故障封存/中断的会话，导出成功（rename 完成）且
 *     purgeAfterSuccess === true && confirmPurge === true 时，复用 recordingService 的删除
 *     路径删除整个内部会话并扣减配额；导出失败/取消完整保留。
 *
 * 逐行流式处理：任何时刻内存中至多一行 + 读写缓冲；绝不把整段/整个会话读入内存。
 *
 * 纯 Node 模块：不依赖 vscode。recordingService / storageRootProvider 由调用方注入；
 * 测试可通过 _io 注入 rename/fdatasync 失败，通过 outputPathValidator 替换路径校验。
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { StringDecoder } = require("string_decoder");

const storage = require("./recordingStorage");
const { RECORDING_ID_PATTERN } = require("./recordingService");

const fsp = fs.promises;

// fs.promises 没有裸 fd 的 fdatasync；与 recordingStorage 相同用回调版包装，
// 并通过自有对象引用让测试可以注入 rename/fdatasync 失败（原子性/清理语义验证）。
const io = {
    /** @type {(fd: number) => Promise<void>} */
    fdatasync: (fd) =>
        new Promise((resolve, reject) => {
            fs.fdatasync(fd, (error) => (error ? reject(error) : resolve()));
        }),
    rename: (from, to) => fsp.rename(from, to)
};

// 最终导出候选状态：停止、配额停止、写失败封存与中断的会话才允许"导出成功后清理"。
const FINAL_EXPORT_STATUSES = new Set(["completed", "stopped-quota", "stopped-error", "interrupted"]);
// 导出器自身的错误码集合：系统/库层错误码（EIO/ENOENT/Z_DATA_ERROR 等）统一收敛为 EXPORT_FAILED。
const EXPORT_ERROR_CODES = new Set([
    "EXPORT_CANCELLED",
    "EXPORT_PATH_INVALID",
    "EXPORT_FAILED",
    "EXPORT_VARIABLE_NOT_FOUND",
    "RECORDING_NOT_FOUND",
    "RECORDING_ACTIVE",
    "CONFIRMATION_REQUIRED"
]);
const DEFAULT_READ_HIGH_WATER_MARK_BYTES = 64 * 1024;

/**
 * 导出结果（promise 的决议值）。
 * @typedef {object} ExportResult
 * @property {boolean} ok 是否成功
 * @property {number} [rows] 导出的数据行数（不含表头）
 * @property {number} [bytes] 导出文件的字节大小（含 BOM 与表头）
 * @property {string} [outputPath] 导出文件的绝对路径
 * @property {boolean} [purged] 是否已删除内部会话（仅成功时携带）
 * @property {string} [purgeError] 清理失败原因（导出已成功但删除内部会话失败时携带）
 * @property {string} [code] 失败错误码
 * @property {string} [message] 失败说明
 */

/** 带错误码的导出异常（EXPORT_* / RECORDING_* / CONFIRMATION_REQUIRED）。 */
function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

/** CSV 字段转义：值含逗号/引号/换行时双引号包裹并翻倍引号（与图表 CSV buildCsv 行为一致）。 */
function csvEscape(text) {
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** time 列格式：ISO 8601 UTC（与图表 CSV 的 time 列一致）。 */
function isoTime(ts) {
    return new Date(ts).toISOString();
}

/** 段排序键：seg-NNNNNN 的数字序号；无法解析的段名排最后。 */
function segmentIndex(segment) {
    const match = segment && segment.name ? /^seg-(\d+)$/.exec(segment.name) : null;
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * 分段选择：时间范围 [fromMs, toMs] 与段边界 [startedAtMs, endedAtMs] 重叠（相切视为重叠）
 * 的全部分段；段缺时间边界时保守纳入（有任一边界时仅用存在的边界方向判断）。
 * 返回按段序号升序排列的段条目数组。
 */
function selectSegments(manifest, fromMs, toMs) {
    const selected = [];
    for (const segment of Array.isArray(manifest.segments) ? manifest.segments : []) {
        if (!segment || typeof segment.file !== "string" || !segment.file) continue;
        const startedAtMs = Number.isFinite(segment.startedAtMs) ? segment.startedAtMs : null;
        const endedAtMs = Number.isFinite(segment.endedAtMs) ? segment.endedAtMs : null;
        if (startedAtMs != null && startedAtMs > toMs) continue; // 段整体在窗口之后
        if (endedAtMs != null && endedAtMs < fromMs) continue; // 段整体在窗口之前
        selected.push(segment);
    }
    selected.sort((a, b) => segmentIndex(a) - segmentIndex(b));
    return selected;
}

/** 段文件绝对路径；防 manifest 篡改：段文件不得逃出会话目录。 */
function segmentFilePath(sessionDir, segment) {
    const filePath = path.resolve(sessionDir, segment.file);
    const relative = path.relative(sessionDir, filePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw codedError("EXPORT_FAILED", `segment file escapes the session directory: ${segment.file}`);
    }
    return filePath;
}

/**
 * 解析导出列：requested 缺省 = 全部固定变量；否则按请求顺序映射到固定变量下标
 * （去重保序）。未知变量 / 空选择抛 EXPORT_VARIABLE_NOT_FOUND。
 * @returns {Array<{name: string, index: number}>}
 */
function resolveColumns(manifest, requested) {
    const fixed = Array.isArray(manifest.fixedVariables) ? manifest.fixedVariables : [];
    if (requested == null) {
        if (fixed.length === 0) {
            throw codedError("EXPORT_VARIABLE_NOT_FOUND", "recording session has no fixed variables");
        }
        return fixed.map((variable, index) => ({ name: String(variable.name), index }));
    }
    if (!Array.isArray(requested)) {
        throw codedError("EXPORT_VARIABLE_NOT_FOUND", "variables must be an array of variable names");
    }
    const names = [];
    for (const name of requested) {
        if (typeof name !== "string") {
            throw codedError("EXPORT_VARIABLE_NOT_FOUND", `invalid variable name: ${String(name)}`);
        }
        if (!names.includes(name)) names.push(name);
    }
    if (names.length === 0) {
        throw codedError("EXPORT_VARIABLE_NOT_FOUND", "no variables selected");
    }
    const columns = [];
    for (const name of names) {
        const index = fixed.findIndex((variable) => variable && variable.name === name);
        if (index < 0) {
            throw codedError("EXPORT_VARIABLE_NOT_FOUND", `variable is not part of this recording: ${name}`);
        }
        columns.push({ name, index });
    }
    return columns;
}

/** 找到路径上已存在的最近祖先（含自身）；到文件系统根仍不存在时返回根（由 realpath 报错）。 */
async function nearestExistingAncestor(targetPath) {
    let current = targetPath;
    for (;;) {
        try {
            await fsp.stat(current);
            return current;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            const parent = path.dirname(current);
            if (parent === current) return current;
            current = parent;
        }
    }
}

/**
 * 缺省输出路径校验器（"路径安全"）：
 *   - outputPath 必须解析为工作区目录内的文件路径：绝对路径需在工作区根之下，
 *     相对路径按工作区根解析；词法拒绝 `..`；
 *   - 解析后对最近已存在祖先做 realpath，拒绝符号链接逃逸到工作区外；
 *   - 目标已存在且为目录时拒绝（最终 rename 必失败）；
 *   - 不存在的目录由导出器在工作区内自动创建，工作区外目录不会被创建。
 * 校验通过返回目标绝对路径；否则抛 EXPORT_PATH_INVALID。
 * @param {() => string} workspaceRootProvider 返回工作区根目录
 * @returns {(outputPath: string) => Promise<string>}
 */
function createDefaultOutputPathValidator(workspaceRootProvider) {
    return async function validateOutputPath(outputPath) {
        if (typeof outputPath !== "string" || outputPath.trim() === "") {
            throw codedError("EXPORT_PATH_INVALID", "outputPath is required");
        }
        const root = path.resolve(String(workspaceRootProvider()));
        let rootReal;
        try {
            rootReal = await fsp.realpath(root);
        } catch (error) {
            throw codedError("EXPORT_PATH_INVALID", `workspace root is not accessible: ${error && error.message}`);
        }
        const resolved = path.resolve(root, outputPath);
        // 词法检查：拒绝 .. 逃逸与空目标（目标必须解析为工作区内、工作区根本身之外的文件）。
        const lexicalRelative = path.relative(root, resolved);
        if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
            throw codedError("EXPORT_PATH_INVALID", "outputPath must resolve to a file inside the workspace");
        }
        // realpath 检查：拒绝符号链接逃逸（最近已存在祖先的 realpath 必须位于工作区根之内）。
        let ancestorReal;
        try {
            const ancestor = await nearestExistingAncestor(resolved);
            ancestorReal = await fsp.realpath(ancestor);
        } catch (error) {
            if (error && error.code === "EXPORT_PATH_INVALID") throw error;
            throw codedError("EXPORT_PATH_INVALID", `output path is not accessible: ${error && error.message}`);
        }
        const realRelative = path.relative(rootReal, ancestorReal);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
            throw codedError("EXPORT_PATH_INVALID", "outputPath escapes the workspace directory via symlinks");
        }
        // 目标已存在且是目录：提前拒绝。
        let targetStat = null;
        try {
            targetStat = await fsp.stat(resolved);
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw codedError("EXPORT_PATH_INVALID", `output path is not usable: ${error && error.message}`);
            }
        }
        if (targetStat && targetStat.isDirectory()) {
            throw codedError("EXPORT_PATH_INVALID", "outputPath is an existing directory");
        }
        return resolved;
    };
}

/**
 * NDJSON 行 → CSV 行文本。
 * 返回 null 表示跳过（内部事件行、范围外样本、.part 段尾被并发写入截断的残缺行）；
 * 完整行损坏（无法解析/缺时间戳）抛 EXPORT_FAILED（.gz 封存段尾残缺同样视为损坏）。
 * @param {string} line 不含行尾换行的单行 JSON 文本
 * @param {Array<{name: string, index: number}>} columns 导出列（固定变量下标映射）
 * @param {number} fromMs 起始时间（含）
 * @param {number} toMs 结束时间（含）
 * @param {boolean} allowTornTail 是否容忍段尾残缺行（仅 .part 活动段）
 * @param {string} segmentName 段名（错误消息定位用）
 * @returns {string|null} CSV 行（含 CRLF）或 null
 */
function rowToCsvText(line, columns, fromMs, toMs, allowTornTail, segmentName) {
    let row;
    try {
        row = JSON.parse(line);
    } catch (error) {
        if (allowTornTail) return null;
        throw codedError("EXPORT_FAILED", `corrupt ndjson line in ${segmentName}: ${error && error.message}`);
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        if (allowTornTail) return null;
        throw codedError("EXPORT_FAILED", `corrupt ndjson line in ${segmentName}: line is not an object`);
    }
    if (row.kind === "recording-event") return null; // 内部事件行：导出必须忽略
    const ts = typeof row.ts === "number" ? row.ts : NaN;
    if (!Number.isFinite(ts)) {
        if (allowTornTail) return null;
        throw codedError("EXPORT_FAILED", `corrupt ndjson line in ${segmentName}: missing sample timestamp`);
    }
    if (ts < fromMs || ts > toMs) return null; // 时间筛选：[fromMs, toMs] 边界含入含出
    const values = Array.isArray(row.v) ? row.v : [];
    const cells = [isoTime(ts)];
    for (const column of columns) {
        const value = values[column.index];
        cells.push(value == null ? "" : csvEscape(String(value))); // 缺失值输出空字段
    }
    return cells.join(",") + "\r\n";
}

/**
 * 创建长录制导出器。选项字段：
 *   - recordingService（必填）：createRecordingService 返回的服务，用于活动会话判定、
 *     在线旋转、最终清理删除路径与缺省工作区根。
 *   - storageRootProvider（必填）：() => 长录制存储根目录（与 recordingService 的 storageRoot
 *     一致，即 <globalStorage>/recordings）；导出器在其一级子目录（工作区哈希）中
 *     定位 <recording-id>.eprec 会话目录。
 *   - clock：可注入时钟 {now}。
 *   - outputPathValidator：可选注入的路径校验器，async (outputPath) => 绝对路径，
 *     非法时抛 code:"EXPORT_PATH_INVALID" 的异常；缺省用 createDefaultOutputPathValidator。
 *   - workspaceRootProvider：可选 () => 工作区根目录，供缺省路径校验器使用；
 *     缺省用 recordingService.workspacePath。
 *   - readHighWaterMarkBytes：可选段读取块大小（测试用），默认 64 KiB。
 * @param {{recordingService: *,
 *          storageRootProvider: () => string,
 *          clock?: {now: () => number},
 *          outputPathValidator?: (outputPath: string) => Promise<string>,
 *          workspaceRootProvider?: () => string,
 *          readHighWaterMarkBytes?: number}} options
 * @returns {{exportRecording: (request: object) => {promise: Promise<ExportResult>, cancel: Function}}}
 */
function createRecordingExporter(options) {
    const recordingService = options.recordingService;
    if (!recordingService || typeof recordingService.status !== "function") {
        throw new Error("recordingService is required");
    }
    if (typeof options.storageRootProvider !== "function") {
        throw new Error("storageRootProvider is required");
    }
    const storageRootProvider = options.storageRootProvider;
    const clock = options.clock || { now: () => Date.now() };
    const workspaceRootProvider =
        typeof options.workspaceRootProvider === "function"
            ? options.workspaceRootProvider
            : () => recordingService.workspacePath;
    const validateOutputPath =
        typeof options.outputPathValidator === "function"
            ? options.outputPathValidator
            : createDefaultOutputPathValidator(workspaceRootProvider);
    const readHighWaterMarkBytes =
        Number.isFinite(options.readHighWaterMarkBytes) && options.readHighWaterMarkBytes > 0
            ? options.readHighWaterMarkBytes
            : DEFAULT_READ_HIGH_WATER_MARK_BYTES;

    function openWriteFd(filePath) {
        return new Promise((resolve, reject) => {
            fs.open(filePath, "w", (error, fd) => (error ? reject(error) : resolve(fd)));
        });
    }

    function closeFd(fd) {
        /** @type {Promise<void>} */
        const done = new Promise((resolve, reject) => {
            fs.close(fd, (error) => (error ? reject(error) : resolve()));
        });
        return done;
    }

    /** 等待写流 drain；流被取消销毁/出错时按取消或错误拒绝。 */
    function waitForDrainOrClose(out, controller) {
        /** @type {Promise<void>} */
        const drained = new Promise((resolve, reject) => {
            const cleanup = () => {
                out.off("drain", onDrain);
                out.off("error", onError);
                out.off("close", onClose);
            };
            const onDrain = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(
                    controller.cancelled
                        ? codedError("EXPORT_CANCELLED", "export cancelled")
                        : new Error("output stream closed unexpectedly")
                );
            };
            out.once("drain", onDrain);
            out.once("error", onError);
            out.once("close", onClose);
        });
        return drained;
    }

    /** 等待写流 finish（end 之后）；取消销毁时按取消拒绝。 */
    function finishWriteStream(out, controller) {
        /** @type {Promise<void>} */
        const finished = new Promise((resolve, reject) => {
            const cleanup = () => {
                out.off("finish", onFinish);
                out.off("error", onError);
                out.off("close", onClose);
            };
            const onFinish = () => {
                cleanup();
                resolve();
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onClose = () => {
                cleanup();
                reject(
                    controller.cancelled
                        ? codedError("EXPORT_CANCELLED", "export cancelled")
                        : new Error("output stream closed before finish")
                );
            };
            out.once("finish", onFinish);
            out.once("error", onError);
            out.once("close", onClose);
        });
        return finished;
    }

    /**
     * 流式处理单个段文件：createReadStream →（.gz 时）gunzip → 按行拆分（处理跨块断行，
     * StringDecoder 处理跨块多字节字符）→ 行筛选/转义 → CSV 写入（尊重写流背压）。
     * @returns {Promise<void>}
     */
    async function pumpSegment(params) {
        const { sessionDir, segment, isGz, out, controller, columns, fromMs, toMs, stats } = params;
        const filePath = segmentFilePath(sessionDir, segment);
        const readStream = fs.createReadStream(filePath, { highWaterMark: readHighWaterMarkBytes });
        controller.streams.add(readStream);
        let gunzip = null;
        let source = readStream;
        if (isGz) {
            gunzip = zlib.createGunzip();
            // 读流错误经 gunzip 传播，保证 for-await 能观测到（.pipe 不自动转发错误）。
            readStream.on("error", (error) => gunzip.destroy(error));
            source = readStream.pipe(gunzip);
            controller.streams.add(gunzip);
        }
        const decoder = new StringDecoder("utf8");
        let tail = "";
        try {
            for await (const chunk of source) {
                tail += decoder.write(chunk);
                let newlineIndex;
                while ((newlineIndex = tail.indexOf("\n")) >= 0) {
                    const line = tail.slice(0, newlineIndex).replace(/\r$/, "");
                    tail = tail.slice(newlineIndex + 1);
                    if (line === "") continue;
                    if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");
                    const text = rowToCsvText(line, columns, fromMs, toMs, false, segment.name || segment.file);
                    if (text == null) continue;
                    if (!out.write(text)) await waitForDrainOrClose(out, controller);
                    stats.rows += 1;
                }
            }
            tail += decoder.end();
            if (tail !== "") {
                // 段尾无换行的残缺片段：.part 可能被并发写入截断（容忍跳过）；.gz 封存段视为损坏。
                const name = segment.name || segment.file;
                const text = rowToCsvText(tail.replace(/\r$/, ""), columns, fromMs, toMs, !isGz, name);
                if (text != null) {
                    if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");
                    if (!out.write(text)) await waitForDrainOrClose(out, controller);
                    stats.rows += 1;
                }
            }
        } finally {
            controller.streams.delete(readStream);
            if (gunzip) controller.streams.delete(gunzip);
            readStream.destroy();
            if (gunzip) gunzip.destroy();
        }
    }

    /** 读取会话 manifest；缺失按 RECORDING_NOT_FOUND，损坏按 EXPORT_FAILED。 */
    async function readSessionManifest(sessionDir) {
        try {
            const manifest = await storage.readManifest(sessionDir);
            if (!manifest) {
                throw codedError("RECORDING_NOT_FOUND", `recording manifest is missing in: ${sessionDir}`);
            }
            return manifest;
        } catch (error) {
            if (error && error.code) throw error;
            throw codedError("EXPORT_FAILED", `failed to read recording manifest: ${error && error.message}`);
        }
    }

    /** 在存储根的一级工作区目录中定位 <recording-id>.eprec 会话目录；找不到返回 null。 */
    async function locateSessionDir(recordingId) {
        const storageRoot = path.resolve(storageRootProvider());
        let workspaces = [];
        try {
            workspaces = await fsp.readdir(storageRoot, { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        for (const entry of workspaces) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(storageRoot, entry.name, `${recordingId}.eprec`);
            try {
                const stat = await fsp.stat(candidate);
                if (stat.isDirectory()) return candidate;
            } catch {
                // 该工作区目录下无此会话：继续扫描。
            }
        }
        return null;
    }

    /**
     * 导出执行体：所有失败以带错误码的异常抛出，由 exportRecording 统一转换为结果对象。
     * 取消/失败只清理 .partial，绝不修改内部录制数据。
     */
    async function runExport(request, controller) {
        // ---- 输入校验（会话状态变更前完成，失败绝不触碰内部录制）
        const recordingId = request.recordingId;
        if (typeof recordingId !== "string" || !RECORDING_ID_PATTERN.test(recordingId)) {
            throw codedError("RECORDING_NOT_FOUND", `unknown recording id: ${recordingId}`);
        }
        const purgeAfterSuccess = request.purgeAfterSuccess === true;
        if (purgeAfterSuccess && request.confirmPurge !== true) {
            throw codedError("CONFIRMATION_REQUIRED", "purge requires explicit confirmation");
        }
        if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");

        const sessionDir = await locateSessionDir(recordingId);
        if (!sessionDir) {
            throw codedError("RECORDING_NOT_FOUND", `unknown recording id: ${recordingId}`);
        }
        // 输出路径校验先行：路径非法时不会旋转/触碰任何会话数据。
        const targetPath = await validateOutputPath(request.outputPath);

        const status = recordingService.status();
        const isActive = Boolean(status && status.recordingActive === true && status.recordingId === recordingId);
        if (isActive && purgeAfterSuccess) {
            // 在线导出无论成败都不清理内部数据（与 Task 2 delete 语义一致）。
            throw codedError("RECORDING_ACTIVE", "online export never purges; stop the recording first");
        }

        let manifest = await readSessionManifest(sessionDir);
        const columns = resolveColumns(manifest, request.variables);
        // 清理只允许"最终导出候选"（停止/配额停止/故障封存/中断）；未封存状态（recording、
        // paused-config 等）可能正被其他实例写入，对 purge 一律拒绝（RECORDING_ACTIVE）。
        if (purgeAfterSuccess && !FINAL_EXPORT_STATUSES.has(String(manifest.status || ""))) {
            throw codedError(
                "RECORDING_ACTIVE",
                `purge requires a finished session, current status: ${manifest.status}`
            );
        }

        // ---- 在线导出：先原子旋转（封存当前段 + 立即开新段），以封口时刻为一致性截止点
        let isActiveExport = false;
        let cutoffMs = null;
        if (isActive) {
            const rotation = await recordingService.rotateActiveSegment();
            if (rotation) {
                isActiveExport = true;
                cutoffMs = rotation.cutoffMs;
                manifest = await readSessionManifest(sessionDir); // 旋转后重读（新增封存段）
            }
        }

        const fromMs = Number.isFinite(request.fromMs) ? request.fromMs : -Infinity;
        const toMs = Number.isFinite(request.toMs) ? request.toMs : Infinity;
        // 截止点之后的样本（新段中的）不属于本次导出：toMs 大于截止点时按截止点截断。
        const effectiveTo = cutoffMs != null ? Math.min(toMs, cutoffMs) : toMs;

        const targets = selectSegments(manifest, fromMs, effectiveTo);
        if (!isActiveExport && manifest.activeSegment && typeof manifest.activeSegment.file === "string") {
            // 非活动会话的遗留活动段（stopped-*/interrupted/paused-config 封存前的 .part）也是数据。
            const activeSegment = manifest.activeSegment;
            if (!targets.some((segment) => segment.name === activeSegment.name)) {
                targets.push(activeSegment);
                targets.sort((a, b) => segmentIndex(a) - segmentIndex(b));
            }
        }

        // ---- 输出准备：工作区内目录可自动创建；<outputPath>.partial 同目录保证原子 rename。
        try {
            await fsp.mkdir(path.dirname(targetPath), { recursive: true });
        } catch (error) {
            throw codedError("EXPORT_PATH_INVALID", `output directory is not usable: ${error && error.message}`);
        }
        const partialPath = `${targetPath}.partial`;
        const stats = { rows: 0, bytes: 0 };
        let fd = null;
        let out = null;
        let outClosed = null;
        let renamed = false;
        try {
            if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");
            fd = await openWriteFd(partialPath);
            out = fs.createWriteStream(null, { fd, autoClose: false });
            controller.streams.add(out);
            // fd 的唯一关闭者是写流本身（destroy 即 close(fd)），避免双重 close 产生 EBADF；
            // 兜底 error 监听防止清理竞态中的错误事件演变为未处理异常（真实写错误仍由
            // waitForDrainOrClose / finishWriteStream 的 once 监听先行观测）。
            out.on("error", () => {});
            outClosed = new Promise((resolve) => out.once("close", resolve));
            // 表头：UTF-8 BOM + time + 选中变量列（列序 = 请求顺序），RFC 4180 转义，行尾 CRLF。
            const header = "\uFEFF" + ["time", ...columns.map((column) => csvEscape(column.name))].join(",") + "\r\n";
            if (!out.write(header)) await waitForDrainOrClose(out, controller);
            for (const segment of targets) {
                if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");
                const isGz = segment.file.endsWith(".gz");
                await pumpSegment({
                    sessionDir,
                    segment,
                    isGz,
                    out,
                    controller,
                    columns,
                    fromMs,
                    toMs: effectiveTo,
                    stats
                });
            }
            if (controller.cancelled) throw codedError("EXPORT_CANCELLED", "export cancelled");
            // ---- 原子完成：end → fdatasync → close → rename；rename 之后取消不再生效。
            out.end();
            await finishWriteStream(out, controller);
            controller.streams.delete(out);
            stats.bytes = out.bytesWritten;
            await io.fdatasync(fd);
            out.destroy(); // 流关闭 fd
            await outClosed;
            fd = null;
            out = null;
            await io.rename(partialPath, targetPath);
            renamed = true;
            controller.finished = true;
        } finally {
            // 失败/取消：销毁写流（其负责关闭 fd）并删除 .partial；rename 已成功则目标是完整产物。
            if (out) {
                controller.streams.delete(out);
                if (!out.destroyed) out.destroy(); // cancel 已销毁时为 no-op
                await outClosed;
            }
            if (fd != null && !out) {
                try {
                    await closeFd(fd); // 写流创建失败等极端情况：手动关闭兜底
                } catch {
                    // fd 已关闭。
                }
            }
            if (!renamed) {
                try {
                    await fsp.unlink(partialPath);
                } catch {
                    // .partial 不存在或已清理。
                }
            }
        }

        const result = { ok: true, rows: stats.rows, bytes: stats.bytes, outputPath: targetPath };
        if (purgeAfterSuccess) {
            // 清理只发生在 rename 成功之后（先保证 CSV 落盘，再删内部数据）；
            // 复用 recordingService 的删除路径（配额统计扣减与路径校验），不旁路自删。
            try {
                await recordingService.delete(recordingId, { confirmed: true });
                result.purged = true;
            } catch (error) {
                // 清理失败不掩盖导出成功：CSV 已落盘，内部会话完整保留。
                result.purged = false;
                result.purgeError = error && error.message ? error.message : String(error);
            }
        } else {
            result.purged = false;
        }
        return result;
    }

    return {
        /**
         * 执行导出；promise 决议为 {ok:true, rows, bytes, outputPath, purged} 或
         * {ok:false, code, message}。支持取消：cancel() 中止流、清理 .partial，
         * promise 决议为 {ok:false, code:"EXPORT_CANCELLED"}；rename 完成后取消不再生效。
         */
        exportRecording(request = {}) {
            const controller = { cancelled: false, finished: false, streams: new Set() };
            const promise = runExport(request, controller).catch((error) => {
                if (controller.cancelled && !controller.finished) {
                    return { ok: false, code: "EXPORT_CANCELLED", message: "export cancelled" };
                }
                if (error && EXPORT_ERROR_CODES.has(error.code)) {
                    return { ok: false, code: error.code, message: error.message };
                }
                // 系统/库层错误码不外泄：统一收敛为 EXPORT_FAILED，原始错误码保留在消息里。
                const prefix = error && error.code ? `${error.code}: ` : "";
                return {
                    ok: false,
                    code: "EXPORT_FAILED",
                    message: error && error.message ? `${prefix}${error.message}` : String(error)
                };
            });
            return {
                promise,
                cancel() {
                    if (controller.finished) return; // rename 已完成：导出已成功，取消无效
                    controller.cancelled = true;
                    for (const stream of controller.streams) {
                        try {
                            stream.destroy();
                        } catch {
                            // 流已销毁。
                        }
                    }
                }
            };
        }
    };
}

module.exports = {
    createRecordingExporter,
    createDefaultOutputPathValidator,
    FINAL_EXPORT_STATUSES,
    csvEscape,
    _io: io
};

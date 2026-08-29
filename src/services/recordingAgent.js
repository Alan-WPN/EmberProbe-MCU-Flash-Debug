"use strict";

/**
 * Agent Bridge 的 recording.* 处理器（"超长录制与选择性 CSV 导出"计划第 5 步）。
 *
 * 边界（计划原文）：Agent Bridge 只传递控制参数和元数据，绝不返回大型 CSV 字符串。
 *   - 入参白名单透传：names/intervalMs/recordingId/variables/fromMs/toMs/outputPath/
 *     purgeAfterSuccess/confirmPurge/confirmed；
 *   - 返回值经字段白名单投影（元数据快照 / 导出结果），样本正文与 CSV 内容不可能出现在
 *     返回值中；
 *   - export 的 outputPath 由桥接层强制按工作区相对路径解析后交给 exporter（绝对路径与
 *     `..` 在此拒绝；工作区边界与符号链接兜底由 exporter 的 outputPathValidator 完成）；
 *   - 同一会话的并发第二次导出被拒绝（EXPORT_IN_PROGRESS），避免并发同路径导出损坏输出。
 *
 * 纯 Node 模块：不依赖 vscode。生命周期入口（start/stop）由接线方注入
 * （mainViewProvider 的 _startRecording/_stopRecording，含采样所有权与状态广播），
 * 测试注入替身即可（test/recording-ui.test.js）。
 */

const recordingUi = require("./recordingUi");

const { codedError, createExportGuard, validateRelativeOutputPath } = recordingUi;

/** 状态快照的字段白名单：只含元数据，绝不包含样本正文/valueText。 */
const STATUS_FIELDS = Object.freeze([
    "recordingId",
    "status",
    "createdAtMs",
    "endedAtMs",
    "rows",
    "bytes",
    "gaps",
    "retries",
    "quota",
    "fixedVariables",
    "recordingActive",
    "backpressure",
    "samplingPaused",
    "resumed",
    "pausedConfigReason",
    "gapActive",
    "occupations"
]);

/** 导出结果的字段白名单：ok/rows/bytes/outputPath/purged（绝不包含 CSV 内容）。 */
const EXPORT_FIELDS = Object.freeze(["ok", "rows", "bytes", "outputPath", "purged"]);

/** 删除结果的字段白名单。 */
const DELETE_FIELDS = Object.freeze(["deleted"]);

/** 按白名单投影对象字段（undefined 字段不拷贝）。 */
function projectFields(value, fields) {
    const source = value && typeof value === "object" ? value : {};
    const out = {};
    for (const field of fields) {
        if (source[field] !== undefined) out[field] = source[field];
    }
    return out;
}

/** 状态快照元数据投影（list 的每个条目也走这里，统一裁剪）。 */
function metadataSnapshot(status) {
    return projectFields(status, STATUS_FIELDS);
}

/** 解析可选的正数毫秒参数（intervalMs/fromMs/toMs）；显式传入但非法时拒绝。 */
function optionalMs(value, name) {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw codedError("INVALID_RECORDING_RANGE", `${name} must be a non-negative number of milliseconds`);
    }
    return Math.floor(parsed);
}

/**
 * 创建 Agent Bridge 的 recording.* 处理器集合。选项字段：
 *   - startRecording：async ({names, intervalMs}) => 状态快照（接线方复用 UI 实现）；
 *   - stopRecording：async () => 状态快照（幂等）；
 *   - statusSync：() => 状态快照（recordingService.status）；
 *   - list：async () => 会话元数据数组（recordingService.list）；
 *   - deleteRecording：async (recordingId, {confirmed}) => {deleted}（recordingService.delete）；
 *   - exporter：createRecordingExporter 返回的导出器；
 *   - guard：可选并发导出闸（缺省创建；接线方应注入与 UI 共用的实例）。
 * @param {{startRecording: Function,
 *          stopRecording: Function,
 *          statusSync: Function,
 *          list: Function,
 *          deleteRecording: Function,
 *          exporter: {exportRecording: (request: Record<string, any>) => {promise: Promise<object>, cancel: Function}},
 *          guard?: {begin: (id: string) => boolean, end: (id: string) => void, isActive: (id: string) => boolean}}} options
 * @returns {Record<string, (params: Record<string, any>) => Promise<object>>} 六个处理器
 */
function createRecordingAgentHandlers(options) {
    const startRecording = options.startRecording;
    const stopRecording = options.stopRecording;
    const statusSync = options.statusSync;
    const list = options.list;
    const exporter = options.exporter;
    const deleteRecording = options.deleteRecording;
    const guard = options.guard || createExportGuard();
    for (const required of [startRecording, stopRecording, statusSync, list, deleteRecording]) {
        if (typeof required !== "function") {
            throw new Error("startRecording/stopRecording/statusSync/list/deleteRecording are required");
        }
    }
    if (!exporter || typeof exporter.exportRecording !== "function") {
        throw new Error("exporter with exportRecording is required");
    }

    return {
        // 启动录制：变量名列表必填（拒绝空集合），间隔可选
        "recording.start": async (params = {}) => {
            const names = Array.isArray(params.names)
                ? params.names.map((name) => String(name || "").trim()).filter(Boolean)
                : [];
            if (!names.length) {
                throw codedError("NO_VARIABLES", "names (variable name list) is required");
            }
            const intervalMs = optionalMs(params.intervalMs, "intervalMs");
            const status = await startRecording({ names, intervalMs });
            return metadataSnapshot(status);
        },

        // 活动/最近会话元数据快照
        "recording.status": async () => metadataSnapshot(statusSync()),

        // 全部会话元数据列表
        "recording.list": async () => {
            const items = await list();
            return { recordings: (Array.isArray(items) ? items : []).map((item) => metadataSnapshot(item)) };
        },

        // 停止录制（幂等）
        "recording.stop": async () => metadataSnapshot(await stopRecording()),

        // 导出为 CSV：只接受控制参数，返回元数据（行数/字节/路径），绝不返回 CSV 正文
        "recording.export": async (params = {}) => {
            const recordingId = typeof params.recordingId === "string" ? params.recordingId : "";
            // 输出路径强制工作区相对路径（绝对路径拒绝）；再由 exporter 校验器兜底边界与符号链接
            const outputPath = validateRelativeOutputPath(params.outputPath);
            const request = {
                recordingId,
                variables: params.variables === undefined ? undefined : params.variables,
                fromMs: optionalMs(params.fromMs, "fromMs"),
                toMs: optionalMs(params.toMs, "toMs"),
                outputPath,
                purgeAfterSuccess: params.purgeAfterSuccess === true,
                confirmPurge: params.confirmPurge === true
            };
            if (!guard.begin(recordingId)) {
                throw codedError(recordingUi.EXPORT_IN_PROGRESS, "an export for this recording is already in progress");
            }
            let result;
            try {
                result = await exporter.exportRecording(request).promise;
            } finally {
                guard.end(recordingId);
            }
            if (!result || result.ok !== true) {
                throw codedError(
                    (result && result.code) || "EXPORT_FAILED",
                    (result && result.message) || "recording export failed"
                );
            }
            return projectFields(result, EXPORT_FIELDS);
        },

        // 删除会话：需要显式确认（缺 --confirm 时 confirmed=false → CONFIRMATION_REQUIRED）
        "recording.delete": async (params = {}) => {
            const recordingId = typeof params.recordingId === "string" ? params.recordingId : "";
            const result = await options.deleteRecording(recordingId, { confirmed: params.confirmed === true });
            return projectFields(result, DELETE_FIELDS);
        }
    };
}

module.exports = { createRecordingAgentHandlers, metadataSnapshot, projectFields, optionalMs };

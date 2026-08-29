"use strict";

/**
 * 长录制 UI 纯逻辑（"超长录制与选择性 CSV 导出"计划第 5 步）：
 *   - 会话列表 QuickPick 条目：状态图标（▶ 活动 / ⏸ 中断 / ■ 停止）+ 起始时间 +
 *     人类可读大小 + 行数；description 携带 gaps/retries/配额摘要；
 *   - 状态 → 动作过滤：活动会话不出现"导出并删除内部数据"、出现"停止"；
 *   - 清理参数构造：purgeAfterSuccess 与 confirmPurge 永远同现（UI 二次确认后才为 true）；
 *   - 时间范围输入解析（空 = 全部）与并发导出闸（同一会话同时只允许一个导出）；
 *   - 桥接层相对输出路径预校验（拒绝绝对路径与 `..`，符号链接兜底由扩展侧校验器完成）。
 *
 * 纯 Node 模块：不依赖 vscode、OpenOCD 或真实探针；从 mainViewProvider 抽出以便
 * 单元测试（test/recording-ui.test.js）。
 */

const path = require("path");

/** 状态图标：▶ 活动（录制中）/ ⏸ 中断（gap 或恢复待续）/ ■ 停止（其余封存状态）。 */
const RECORDING_STATUS_ICONS = Object.freeze({
    active: "▶",
    interrupted: "⏸",
    finished: "■"
});

/** 活动状态集合：只有 recording 才算进行中的活动会话。 */
const ACTIVE_STATUSES = new Set(["recording"]);

/** 中断状态：探针断连后等待续录或恢复匹配失败保留数据的会话。 */
const INTERRUPTED_STATUSES = new Set(["interrupted", "paused-config"]);

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;

/** 导出并发错误码：同一会话已有导出进行中。 */
const EXPORT_IN_PROGRESS = "EXPORT_IN_PROGRESS";

/** 带错误码的异常（EXPORT_PATH_INVALID / INVALID_RECORDING_RANGE / EXPORT_IN_PROGRESS）。 */
function codedError(code, message) {
    return Object.assign(new Error(message), { code });
}

/** 会话状态分桶：active / interrupted / finished（未知状态按封存处理，保守可清理判定交给 exporter）。 */
function statusBucket(status) {
    const text = String(status || "");
    if (ACTIVE_STATUSES.has(text)) return "active";
    if (INTERRUPTED_STATUSES.has(text)) return "interrupted";
    return "finished";
}

/** 状态图标（未知状态按停止处理）。 */
function statusIcon(status) {
    return RECORDING_STATUS_ICONS[statusBucket(status)] || RECORDING_STATUS_ICONS.finished;
}

/** 是否活动会话（recording）。 */
function isActiveStatus(status) {
    return statusBucket(status) === "active";
}

/** 人类可读字节：B / KiB / MiB / GiB，一位小数（整数不带小数）。 */
function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0B";
    if (value < BYTES_PER_KIB) return `${Math.round(value)}B`;
    const withUnit = (divisor, unit) => {
        const scaled = value / divisor;
        const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1);
        return `${text}${unit}`;
    };
    if (value < BYTES_PER_MIB) return withUnit(BYTES_PER_KIB, "KiB");
    if (value < BYTES_PER_GIB) return withUnit(BYTES_PER_MIB, "MiB");
    return withUnit(BYTES_PER_GIB, "GiB");
}

/** 人类可读行数：45.2k / 1.23M / 123。 */
function formatCount(count) {
    const value = Number(count);
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value < 1000) return String(Math.round(value));
    if (value < 1000 * 1000) {
        const scaled = value / 1000;
        return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}k`;
    }
    const scaled = value / (1000 * 1000);
    return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(2))}M`;
}

/** 会话起始时间的本地显示文本（YYYY-MM-DD HH:mm:ss）。 */
function formatSessionTime(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "—";
    const date = new Date(value);
    const two = (n) => String(n).padStart(2, "0");
    return (
        `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
        `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
    );
}

/** 配额摘要：usedBytes 相对 maxMiB 的百分比；无配额信息返回 null。 */
function quotaSummary(quota) {
    if (!quota || typeof quota !== "object") return null;
    const used = Number(quota.usedBytes);
    const maxMiB = Number(quota.maxMiB);
    if (!Number.isFinite(used) || !Number.isFinite(maxMiB) || maxMiB <= 0) return null;
    const percent = Math.round((used / (maxMiB * BYTES_PER_MIB)) * 1000) / 10;
    return `${formatBytes(used)}/${maxMiB}MiB ${percent}%`;
}

/**
 * 录制会话 → QuickPick 条目（纯元数据）：
 *   label = 状态图标 + 起始时间 + 大小 + 行数；description = gaps/retries/配额摘要。
 * 绝不包含样本正文或 valueText。
 */
function sessionQuickPickItem(snapshot) {
    const snap = snapshot || {};
    const status = String(snap.status || "unknown");
    const label = `${statusIcon(status)} ${formatSessionTime(snap.createdAtMs)} · ${formatBytes(snap.bytes)} · ${formatCount(snap.rows)}`;
    const parts = [];
    if (Number.isFinite(Number(snap.gaps)) && Number(snap.gaps) > 0) parts.push(`gaps:${Number(snap.gaps)}`);
    // recordingService.list() 的条目字段名为 retries（_snapshotFromManifest 契约）
    const retry = snap.retries;
    if (retry && Number.isFinite(Number(retry.attempt)) && Number(retry.attempt) > 0) {
        parts.push(`retry:${Number(retry.attempt)}`);
    }
    const quota = quotaSummary(snap.quota);
    if (quota) parts.push(`quota ${quota}`);
    return {
        label,
        description: parts.join(" · "),
        recordingId: typeof snap.recordingId === "string" ? snap.recordingId : "",
        status,
        snapshot: snap
    };
}

/**
 * 状态 → 二级动作可用性过滤：
 *   - "导出并删除内部数据" 仅非活动会话（活动会话永远拒绝清理）；
 *   - "停止" 仅活动会话；
 *   - "删除" 始终可见（活动会话选择时先提示先停止）。
 */
function actionsForSession(snapshot) {
    const status = String((snapshot && snapshot.status) || "unknown");
    const active = isActiveStatus(status);
    return {
        export: true,
        exportPurge: !active,
        stop: active,
        delete: true,
        refresh: true
    };
}

/** 清理参数构造：confirmed 才允许 purgeAfterSuccess/confirmPurge 同真（UI 二次确认后）。 */
function purgeExportParams(confirmed) {
    return confirmed === true
        ? { purgeAfterSuccess: true, confirmPurge: true }
        : { purgeAfterSuccess: false, confirmPurge: false };
}

/**
 * 时间范围输入解析（QuickPick/showInputBox 的文本）：空 = 全部（null）；
 * 非数字或 from > to 抛 INVALID_RECORDING_RANGE。
 * @returns {{fromMs: number|null, toMs: number|null}}
 */
function parseTimeRangeInput(fromText, toText) {
    const parse = (text, name) => {
        const trimmed = String(text == null ? "" : text).trim();
        if (!trimmed) return null;
        const value = Number(trimmed);
        if (!Number.isFinite(value) || value < 0) {
            throw codedError("INVALID_RECORDING_RANGE", `${name} must be a non-negative UTC millisecond timestamp`);
        }
        return Math.floor(value);
    };
    const fromMs = parse(fromText, "fromMs");
    const toMs = parse(toText, "toMs");
    if (fromMs != null && toMs != null && fromMs > toMs) {
        throw codedError("INVALID_RECORDING_RANGE", "fromMs must not be later than toMs");
    }
    return { fromMs, toMs };
}

/** 并发导出闸：同一会话同时只允许一个导出（在线导出与最终导出共用）。 */
function createExportGuard() {
    const active = new Set();
    return {
        isActive: (recordingId) => active.has(recordingId),
        /** 已有在途导出返回 false（调用方拒绝并发），否则登记并返回 true。 */
        begin(recordingId) {
            const key = String(recordingId || "");
            if (active.has(key)) return false;
            active.add(key);
            return true;
        },
        end(recordingId) {
            active.delete(String(recordingId || ""));
        }
    };
}

/**
 * Agent 桥接层输出路径预校验：必须是工作区内相对路径（拒绝绝对路径、盘符与 `..` 逃逸）。
 * 返回正斜杠归一化的相对路径；符号链接逃逸与工作区边界由扩展侧 outputPathValidator 兜底。
 */
function validateRelativeOutputPath(outputPath) {
    if (typeof outputPath !== "string" || !outputPath.trim()) {
        throw codedError("EXPORT_PATH_INVALID", "outputPath is required");
    }
    const text = outputPath.trim();
    if (path.isAbsolute(text) || /^([A-Za-z]:[\\/]|\\\\)/.test(text)) {
        throw codedError("EXPORT_PATH_INVALID", "outputPath must be a workspace-relative path");
    }
    const segments = text.split(/[\\/]+/);
    if (segments.some((segment) => segment === "..")) {
        throw codedError("EXPORT_PATH_INVALID", 'outputPath must not contain ".."');
    }
    const normalized = segments.filter((segment) => segment && segment !== ".").join("/");
    if (!normalized || normalized === ".") {
        throw codedError("EXPORT_PATH_INVALID", "outputPath must name a CSV file inside the workspace");
    }
    return normalized;
}

module.exports = {
    RECORDING_STATUS_ICONS,
    EXPORT_IN_PROGRESS,
    codedError,
    statusBucket,
    statusIcon,
    isActiveStatus,
    formatBytes,
    formatCount,
    formatSessionTime,
    quotaSummary,
    sessionQuickPickItem,
    actionsForSession,
    purgeExportParams,
    parseTimeRangeInput,
    createExportGuard,
    validateRelativeOutputPath
};

"use strict";

/**
 * 长录制的采样侧纯逻辑（Task 3）：
 *   - buildRecorderSample：统一采样入口的原始样本 → 固定 schema 的 valueText 行与 meta；
 *   - recorderFeedSchema：喂入决策（无活动录制 / 写队列高水位 → 不喂）；
 *   - recorderSampleSource：录制行 src 标注（graph/sidebar 优先，纯录制采样标 recorder）；
 *   - RecorderReconnectScheduler：探针断连后的 1/2/5/10/30 秒退避重连状态机（注入时钟）；
 *   - shouldStopSampling / consumersAfterRecorderRelease：'recorder' 采样所有者语义。
 *
 * 全部为纯函数或仅依赖注入时钟的状态机，不依赖 vscode、OpenOCD 或真实探针；
 * 从 mainViewProvider 抽出以便单元测试（test/recording-sampling.test.js）。
 */

const elfSymbols = require("../elfSymbols");

/** 探针断连后的退避序列（ms）：逐次升级，30s 封顶后持续以 30s 重试；任一次成功即复位。 */
const RETRY_BACKOFF_SEQUENCE_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);

const defaultClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        if (timer && typeof timer.unref === "function") timer.unref();
        return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer)
};

/**
 * 精度优先解码：优先 elfSymbols.decodeValueText（u64/i64 的精确十进制与 f64 的
 * NaN/Infinity 文本表示），其余类型或解码失败回退 decodeValue 的数值文本；
 * 未知类型、字节不足、解码异常一律返回 null。
 */
function decodeValueTextWithFallback(symbols, bytes, type) {
    try {
        const exact = symbols.decodeValueText(bytes, type);
        if (exact !== null && exact !== undefined) return String(exact);
    } catch {
        // 精确文本解码异常按失败处理，进入数值回退。
    }
    try {
        const value = symbols.decodeValue(bytes, type);
        return value === null || value === undefined ? null : String(value);
    } catch {
        return null;
    }
}

/**
 * 把一轮统一采样入口的原始样本映射为录制行（纯函数，单次调用 O(schema 大小)）。
 *
 * values 按 schema 固定顺序输出 valueText/null：raw bytes 存在时用 schema 自身的 type
 * 独立解码（与 Webview 的消费类型解码路径无关），raw bytes 缺失（读取失败）→ null。
 * 全部列失败 → meta.complete:false（整行空值样本仍写入）；部分失败 → meta.partial:true
 * 且成功变量保留。schema 无变量时返回 null（无可录制列）。
 *
 * @param {{variables: Array<{name: string, type?: string|null}>, startTimeMs?: number,
 *          source?: string}} schema 启动时冻结的固定 schema + 录制起始时间
 * @param {Array<{name: string, bytes?: Uint8Array|Buffer|null}>} samples 原始字节样本
 * @param {number} t 本轮采样时间戳（ms）
 * @param {{elfSymbols?: object}} [options] 注入 elfSymbols 替身便于测试
 * @returns {{values: Array<string|null>, meta: {tMs: number|null, elapsedMs: number|null,
 *           source: string, complete: boolean, partial: boolean}} | null}
 */
function buildRecorderSample(schema, samples, t, options = {}) {
    const variables = schema && Array.isArray(schema.variables) ? schema.variables : [];
    if (!variables.length) return null;
    const symbols = options.elfSymbols || elfSymbols;
    const byName = new Map();
    for (const sample of Array.isArray(samples) ? samples : []) {
        if (sample && typeof sample.name === "string" && sample.name && !byName.has(sample.name)) {
            byName.set(sample.name, sample);
        }
    }
    const values = [];
    let failed = 0;
    for (const variable of variables) {
        const sample = variable ? byName.get(variable.name) : null;
        const bytes = sample ? sample.bytes : null;
        const text = bytes ? decodeValueTextWithFallback(symbols, bytes, variable && variable.type) : null;
        if (text === null) failed += 1;
        values.push(text);
    }
    const startTimeMs = Number.isFinite(schema.startTimeMs) ? schema.startTimeMs : null;
    return {
        values,
        meta: {
            tMs: typeof t === "number" ? t : null,
            elapsedMs: startTimeMs != null && typeof t === "number" ? t - startTimeMs : null,
            source: typeof schema.source === "string" && schema.source ? schema.source : "recorder",
            complete: failed < variables.length,
            partial: failed > 0 && failed < variables.length
        }
    };
}

/**
 * 采样馈送决策：统一采样入口每轮调用。返回应喂给录制器的 schema（附带实际 source 标注），
 * 不喂时返回 null——无活动录制，或 recordingService.shouldPauseSampling() 为 true
 * （写队列高水位/硬上限、配额/写错误安全停止后）时暂停喂入；写队列排空后自动恢复。
 */
function recorderFeedSchema(schema, options = {}) {
    if (!schema || !Array.isArray(schema.variables) || !schema.variables.length) return null;
    if (options.paused === true) return null;
    const source = typeof options.source === "string" && options.source ? options.source : schema.source;
    return { ...schema, source: typeof source === "string" && source ? source : "recorder" };
}

/** 录制行 src 标注：实际采样路径归属（graph/sidebar 优先；仅录制器拥有采样时标 recorder）。 */
function recorderSampleSource(consumers) {
    if (consumers && typeof consumers.has === "function") {
        if (consumers.has("graph")) return "graph";
        if (consumers.has("sidebar")) return "sidebar";
    }
    return "recorder";
}

/**
 * 图表/侧栏的停止请求是否应真正终止采样会话：
 * 'recorder' 在所有者集合时保持会话运行（关闭、冻结、清空或停止图表不能终止活动录制）。
 */
function shouldStopSampling(consumers) {
    return !(consumers && typeof consumers.has === "function" && consumers.has("recorder"));
}

/** 录制停止/安全停止后移除 'recorder' 所有权；返回剩余所有者集合（为空时应停止采样）。 */
function consumersAfterRecorderRelease(consumers) {
    const remaining = new Set(consumers || []);
    remaining.delete("recorder");
    return remaining;
}

/**
 * 重启续录会话采纳后的采样恢复决策（计划：配置/ELF/硬件全部匹配的自动续录应恢复产生样本）。
 * @param {{recordingActive?: boolean}} status recordingService.whenReady() 的状态快照
 * @param {{samplingRunning?: boolean, occupationActive?: boolean}} [state]
 *   samplingRunning：standalone 采样会话是否在运行；occupationActive：下载/调试切换等显式占用是否进行中
 * @returns {"start"|"refresh"|"defer"|null}
 *   "start"：采样未运行且无显式占用 → 以 'recorder' 为所有者自动走现有启动路径；
 *   "refresh"：采样已运行 → 仅把录制变量并入读取计划；
 *   "defer"：显式占用进行中 → 暂缓（占用释放后的立即重连机制接手）；
 *   null：非活动会话，不采纳。
 */
function recorderResumeAction(status, state = {}) {
    if (!status || status.recordingActive !== true) return null;
    if (state.samplingRunning === true) return "refresh";
    if (state.occupationActive === true) return "defer";
    return "start";
}

/**
 * 退避重连/立即重连尝试的探针门控：cortex-debug 启动进行中或调试会话存活时，
 * 独立 OpenOCD 采样会话不得启动（避免与调试争抢探针）；defer 时保持退避循环，
 * 调试结束后由 restoreSamplingAfterDebug / 占用释放路径接手。
 * @param {{debugStarting?: boolean, debugCommandPending?: boolean,
 *          debugSessionAlive?: boolean, activeDebugSession?: boolean}} [state]
 * @returns {"start"|"defer-debug"}
 */
function recorderReconnectGate(state = {}) {
    const debugBusy =
        state.debugStarting === true ||
        state.debugCommandPending === true ||
        state.debugSessionAlive === true ||
        state.activeDebugSession === true;
    return debugBusy ? "defer-debug" : "start";
}

/**
 * 调试占用看门狗判定：'debug' 显式占用必须持续到调试会话真正结束或启动失败；
 * 外部 cortex-debug 启动被用户取消/解析失败时调试会话始终不会附着，占用须在看门狗
 * 到点后有界释放，否则录制重连被永久阻塞。
 * @param {{debugSessionAlive?: boolean, activeDebugSession?: boolean,
 *          debugStarting?: boolean}} [state]
 * @returns {"keep"|"release"}
 */
function recorderDebugWatchdogAction(state = {}) {
    const alive = state.debugSessionAlive === true || state.activeDebugSession === true || state.debugStarting === true;
    return alive ? "keep" : "release";
}

/**
 * 强制停止（探针被下载/调试切换/扩展停机接管）后的采样所有者集合：
 * 录制仍活跃时必须保留 'recorder' 所有权位——任何路径下丢失该位都会让
 * 普通（无 force）停止请求终止活动录制且无重连恢复。
 * @param {boolean} recordingActive 录制会话是否仍活跃
 * @returns {Set<string>}
 */
function ownersAfterForceStop(recordingActive) {
    const owners = new Set();
    if (recordingActive === true) owners.add("recorder");
    return owners;
}

/**
 * 可注入时钟（与 recordingService 的 clock 契约一致）。
 * @typedef {{now: () => number, setTimeout: (fn: () => void, ms: number) => any,
 *            clearTimeout: (timer: any) => void}} SamplerClock
 */

/**
 * 探针断连退避重连状态机：序列 [1000, 2000, 5000, 10000, 30000]ms 逐次升级，
 * 30s 封顶后持续以 30s 重试；任一次连接成功（reset）→ 序列复位。
 * 计时通过注入 clock（{now, setTimeout, clearTimeout}），便于测试与取消。
 */
class RecorderReconnectScheduler {
    /**
     * @param {{clock?: SamplerClock, sequence?: number[], onFire?: (attempt: number) => void}} [options]
     */
    constructor(options = {}) {
        this._clock = options.clock || defaultClock;
        this._sequence =
            Array.isArray(options.sequence) && options.sequence.length ? options.sequence : RETRY_BACKOFF_SEQUENCE_MS;
        this._onFire = typeof options.onFire === "function" ? options.onFire : () => {};
        this._attempt = 0;
        this._timer = null;
        this._pending = null;
    }

    /** 已推进到的重试档位（下一次 schedule 将使用的 attempt 值）。 */
    get attempt() {
        return this._attempt;
    }

    /** 挂起的重试（{attempt, nextAtMs}）或 null。 */
    get pending() {
        return this._pending;
    }

    /** 排下一次退避重试：返回 {attempt, delayMs, nextAtMs}；已挂起时先取消旧计时器。 */
    schedule(now = this._clock.now()) {
        this.cancel();
        const delayMs = this._sequence[Math.min(this._attempt, this._sequence.length - 1)];
        const attempt = this._attempt + 1;
        const nextAtMs = now + delayMs;
        this._attempt = attempt;
        this._pending = { attempt, nextAtMs };
        this._timer = this._clock.setTimeout(() => {
            this._timer = null;
            this._pending = null;
            this._onFire(attempt);
        }, delayMs);
        return { attempt, delayMs, nextAtMs };
    }

    /** 取消挂起的重连计时器（保留退避进度）；录制停止或探针被显式占用时调用。 */
    cancel() {
        if (this._timer) {
            this._clock.clearTimeout(this._timer);
            this._timer = null;
        }
        this._pending = null;
    }

    /** 连接成功：复位退避序列并取消挂起重试。 */
    reset() {
        this.cancel();
        this._attempt = 0;
    }

    /** 立即触发一次重连（显式占用释放后不等退避计时器）；不推进退避档位。 */
    retryNow() {
        const attempt = Math.max(1, this._attempt);
        this.cancel();
        this._onFire(attempt);
    }
}

/** 创建退避重连状态机。 */
function createReconnectScheduler(options) {
    return new RecorderReconnectScheduler(options);
}

module.exports = {
    RETRY_BACKOFF_SEQUENCE_MS,
    defaultClock,
    buildRecorderSample,
    recorderFeedSchema,
    recorderSampleSource,
    shouldStopSampling,
    consumersAfterRecorderRelease,
    recorderResumeAction,
    recorderReconnectGate,
    recorderDebugWatchdogAction,
    ownersAfterForceStop,
    RecorderReconnectScheduler,
    createReconnectScheduler
};

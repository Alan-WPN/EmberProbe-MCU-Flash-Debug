"use strict";

/**
 * 长录制采样集成测试（Task 3）：recorderSampler 纯逻辑 + 退避重连状态机 +
 * 所有者语义 + 占用恢复 + pause 语义，并用真实 recordingService 做一次端到端喂入。
 *
 * 全部不依赖 VS Code、OpenOCD 或真实探针。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
    RETRY_BACKOFF_SEQUENCE_MS,
    RecorderReconnectScheduler,
    buildRecorderSample,
    consumersAfterRecorderRelease,
    createReconnectScheduler,
    recorderFeedSchema,
    recorderResumeAction,
    recorderSampleSource,
    shouldStopSampling
} = require("../src/services/recorderSampler");
const { createRecordingService } = require("../src/services/recordingService");

// ------------------------------------------------------------------ 工具函数

function makeTempRoot(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 注入替身 context：globalStorageUri 为存储根，storageUri 充当稳定的工作区身份。 */
function makeContext(root) {
    return {
        globalStorageUri: { fsPath: root },
        storageUri: { fsPath: path.join(root, "workspace-identity") }
    };
}

function makeFakeClock(startMs = 1700000000000) {
    let current = startMs;
    const timers = new Set();
    return {
        now: () => current,
        setTimeout: (fn, ms) => {
            const timer = { fn, at: current + ms };
            timers.add(timer);
            return timer;
        },
        clearTimeout: (timer) => {
            if (timer) timers.delete(timer);
        },
        advance: (ms) => {
            current += ms;
            for (;;) {
                const due = [...timers].filter((timer) => timer.at <= current).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers.delete(due);
                due.fn();
            }
        }
    };
}

/** 读取会话目录当前活动 .part（或唯一数据文件）的 NDJSON 行（JSON 数组）。 */
function readNdjsonLines(sessionDir) {
    const entries = fs.readdirSync(sessionDir).filter((name) => name.endsWith(".ndjson.part")).sort();
    const lines = [];
    for (const entry of entries) {
        const text = fs.readFileSync(path.join(sessionDir, entry), "utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    for (const entry of fs.readdirSync(sessionDir).filter((name) => name.endsWith(".ndjson.gz")).sort()) {
        const text = zlib.gunzipSync(fs.readFileSync(path.join(sessionDir, entry))).toString("utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    return lines;
}

/** 复刻 mainViewProvider._feedRecorderSamples 的馈送管线（stub recordingService 便于断言）。 */
function makeFeedHarness(schema, consumers) {
    const calls = { ingests: [], pauses: 0 };
    const stubService = {
        shouldPauseSampling: () => {
            calls.pauses += 1;
            return stubService.paused;
        },
        paused: false,
        ingestSample: async (values, meta) => {
            calls.ingests.push({ values, meta });
            return { written: true, seq: calls.ingests.length };
        }
    };
    return {
        calls,
        stubService,
        feed(samples, t) {
            const active = schema && schema.variables && schema.variables.length;
            if (!active) return null;
            const feed = recorderFeedSchema(schema, {
                paused: stubService.shouldPauseSampling(),
                source: recorderSampleSource(consumers)
            });
            if (!feed) return null;
            const built = buildRecorderSample(feed, samples, t);
            if (!built) return null;
            void stubService.ingestSample(built.values, built.meta);
            return built;
        }
    };
}

// -------------------------------------------------------------------- 测试主体

(async () => {
    // ---- 退避序列常量（简报逐字值）----
    assert.deepStrictEqual([...RETRY_BACKOFF_SEQUENCE_MS], [1000, 2000, 5000, 10000, 30000]);
    console.log("backoff sequence constant ok");

    // ---- buildRecorderSample：完整成功（valueText 精度优先）----
    {
        const u64Bytes = new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x20, 0x00]); // 2^53 + 1
        const f32Bytes = new Uint8Array(4);
        new DataView(f32Bytes.buffer).setFloat32(0, 0.1, true);
        const schema = {
            variables: [
                { name: "counter", type: "u64", address: "0x20000000", size: 8 },
                { name: "temp", type: "f32", address: "0x20000008", size: 4 },
                { name: "mode", type: "i8", address: "0x2000000C", size: 1 }
            ],
            startTimeMs: 1000,
            source: "recorder"
        };
        const samples = [
            { name: "counter", bytes: u64Bytes, t: 1500 },
            { name: "temp", bytes: f32Bytes, t: 1500 },
            { name: "mode", bytes: new Uint8Array([0xfb]), t: 1500 }
        ];
        const built = buildRecorderSample(schema, samples, 1500);
        assert.ok(built);
        // u64 走 decodeValueText 精确十进制（Number 化会丢失精度：9007199254740992）
        assert.strictEqual(built.values[0], "9007199254740993");
        // f32/i8 走 decodeValue 数值文本回退
        assert.strictEqual(built.values[1], "0.10000000149011612");
        assert.strictEqual(built.values[2], "-5");
        assert.deepStrictEqual(built.meta, {
            tMs: 1500,
            elapsedMs: 500,
            source: "recorder",
            complete: true,
            partial: false
        });
    }
    console.log("buildRecorderSample full success ok");

    // ---- buildRecorderSample：部分失败（partial:true，成功列保留）----
    {
        const schema = {
            variables: [
                { name: "a", type: "u32", address: "0x20000000", size: 4 },
                { name: "b", type: "f32", address: "0x20000004", size: 4 }
            ],
            startTimeMs: 0
        };
        const built = buildRecorderSample(schema, [{ name: "a", bytes: new Uint8Array([42, 0, 0, 0]) }, { name: "b", bytes: null }], 2000);
        assert.deepStrictEqual(built.values, ["42", null]);
        assert.strictEqual(built.meta.complete, true);
        assert.strictEqual(built.meta.partial, true);
    }
    console.log("buildRecorderSample partial failure ok");

    // ---- buildRecorderSample：全失败（complete:false，整行 null 仍输出）----
    {
        const schema = {
            variables: [
                { name: "a", type: "u32", address: "0x20000000", size: 4 },
                { name: "b", type: "u32", address: "0x20000004", size: 4 }
            ]
        };
        const built = buildRecorderSample(schema, [{ name: "a", bytes: null }, { name: "b", bytes: null }], 3000);
        assert.deepStrictEqual(built.values, [null, null]);
        assert.strictEqual(built.meta.complete, false);
        assert.strictEqual(built.meta.partial, false);
        assert.strictEqual(built.meta.source, "recorder");
    }
    console.log("buildRecorderSample complete failure ok");

    // ---- buildRecorderSample：unknown type / 字节不足 → null ----
    {
        const schema = { variables: [{ name: "a", type: "weird-type", address: "0x20000000", size: 4 }] };
        const built = buildRecorderSample(schema, [{ name: "a", bytes: new Uint8Array([1, 2, 3, 4]) }], 0);
        assert.deepStrictEqual(built.values, [null]);
        assert.strictEqual(built.meta.complete, false);
        const short = buildRecorderSample(
            { variables: [{ name: "a", type: "u64", address: "0x20000000", size: 8 }] },
            [{ name: "a", bytes: new Uint8Array([1, 2, 3, 4]) }],
            0
        );
        assert.deepStrictEqual(short.values, [null]);
        assert.strictEqual(buildRecorderSample(null, [], 0), null);
        assert.strictEqual(buildRecorderSample({ variables: [] }, [], 0), null);
        // 样本列表缺失时按整行失败处理
        const missing = buildRecorderSample(
            { variables: [{ name: "a", type: "u32", address: "0x20000000", size: 4 }] },
            undefined,
            10
        );
        assert.deepStrictEqual(missing.values, [null]);
    }
    console.log("buildRecorderSample unknown type fallback ok");

    // ---- buildRecorderSample：decodeValueText 异常/空值时回退 decodeValue ----
    {
        const throwingSymbols = {
            decodeValueText: () => {
                throw new Error("boom");
            },
            decodeValue: (bytes, type) => (type === "u32" ? 7 : null)
        };
        const built = buildRecorderSample(
            { variables: [{ name: "a", type: "u32", address: "0x20000000", size: 4 }] },
            [{ name: "a", bytes: new Uint8Array([7, 0, 0, 0]) }],
            0,
            { elfSymbols: throwingSymbols }
        );
        assert.deepStrictEqual(built.values, ["7"]);
        const nullSymbols = {
            decodeValueText: () => null,
            decodeValue: () => null
        };
        const failed = buildRecorderSample(
            { variables: [{ name: "a", type: "u32", address: "0x20000000", size: 4 }] },
            [{ name: "a", bytes: new Uint8Array([7, 0, 0, 0]) }],
            0,
            { elfSymbols: nullSymbols }
        );
        assert.deepStrictEqual(failed.values, [null]);
    }
    console.log("buildRecorderSample valueText fallback ok");

    // ---- 退避状态机：1/2/5/10/30 秒逐档升级、30s 封顶、成功复位、注入假 clock ----
    {
        const clock = makeFakeClock();
        const fired = [];
        const scheduler = createReconnectScheduler({ clock, onFire: (attempt) => fired.push(attempt) });
        const expected = [1000, 2000, 5000, 10000, 30000, 30000];
        for (let index = 0; index < expected.length; index += 1) {
            const nowBefore = clock.now();
            const info = scheduler.schedule();
            assert.strictEqual(info.attempt, index + 1);
            assert.strictEqual(info.delayMs, expected[index]);
            assert.strictEqual(info.nextAtMs, nowBefore + expected[index]);
            assert.deepStrictEqual(scheduler.pending, { attempt: info.attempt, nextAtMs: info.nextAtMs });
            clock.advance(expected[index]);
            assert.deepStrictEqual(fired, [info.attempt]);
            fired.length = 0;
            assert.strictEqual(scheduler.pending, null);
        }
        // 任一次成功 → 序列复位
        scheduler.reset();
        assert.strictEqual(scheduler.attempt, 0);
        const restarted = scheduler.schedule();
        assert.strictEqual(restarted.delayMs, 1000);
        assert.strictEqual(restarted.attempt, 1);
        scheduler.reset();
        assert.strictEqual(scheduler.pending, null);
        clock.advance(1000);
        assert.deepStrictEqual(fired, []);
    }
    console.log("backoff state machine sequence/cap/reset ok");

    // ---- 退避状态机：取消挂起重连（录制停止时清除计时器）----
    {
        const clock = makeFakeClock();
        const fired = [];
        const scheduler = new RecorderReconnectScheduler({ clock, onFire: (attempt) => fired.push(attempt) });
        scheduler.schedule();
        scheduler.cancel();
        assert.strictEqual(scheduler.pending, null);
        clock.advance(60000);
        assert.deepStrictEqual(fired, []);
        // 重复 schedule 取消旧计时器，只保留最新一档
        const first = scheduler.schedule();
        const second = scheduler.schedule();
        assert.notStrictEqual(second.attempt, first.attempt);
        clock.advance(1000);
        assert.deepStrictEqual(fired, []); // 第一档计时器已被取消
        clock.advance(second.delayMs);
        assert.deepStrictEqual(fired, [second.attempt]);
    }
    console.log("backoff scheduler cancel ok");

    // ---- 占用恢复：releaseOccupation 后立即重连，不再等退避计时器 ----
    {
        const clock = makeFakeClock();
        const fired = [];
        const scheduler = createReconnectScheduler({ clock, onFire: (attempt) => fired.push(attempt) });
        scheduler.schedule(); // 已排下一次退避重试
        assert.ok(scheduler.pending);
        // 模拟 _releaseRecorderOccupation：取消挂起计时器并立即触发
        scheduler.retryNow();
        assert.deepStrictEqual(fired.length, 1);
        assert.strictEqual(scheduler.pending, null);
        clock.advance(60000); // 不得再触发（旧计时器已取消）
        assert.deepStrictEqual(fired.length, 1);
    }
    console.log("occupation release immediate reconnect ok");

    // ---- 所有者语义：'recorder' 存在时 stop 请求不清空采样；移除后按剩余所有者决定 ----
    {
        assert.strictEqual(shouldStopSampling(new Set(["graph", "sidebar"])), true);
        assert.strictEqual(shouldStopSampling(new Set(["graph", "sidebar", "recorder"])), false);
        assert.strictEqual(shouldStopSampling(new Set(["recorder"])), false);
        // recorder 唯一所有者：移除后应停止
        const alone = consumersAfterRecorderRelease(new Set(["recorder"]));
        assert.strictEqual(alone.size, 0);
        // 图表仍在采样：移除后保持运行
        const shared = consumersAfterRecorderRelease(new Set(["recorder", "graph", "sidebar"]));
        assert.strictEqual(shared.size, 2);
        assert.ok(shared.has("graph") && shared.has("sidebar") && !shared.has("recorder"));
        // src 标注：graph/sidebar 优先，纯录制采样标 recorder
        assert.strictEqual(recorderSampleSource(new Set(["recorder", "graph"])), "graph");
        assert.strictEqual(recorderSampleSource(new Set(["recorder", "sidebar"])), "sidebar");
        assert.strictEqual(recorderSampleSource(new Set(["recorder"])), "recorder");
    }
    console.log("owner semantics ok");

    // ---- 重启续录采纳：配置/ELF/硬件匹配的恢复会话应自动恢复产生样本 ----
    {
        const resumed = {
            recordingActive: true,
            status: "recording",
            fixedVariables: [{ name: "temp", type: "u32", address: "0x20000000", size: 4 }],
            createdAtMs: 1000
        };
        // 决策纯函数：采样未运行且无占用 → 自动启动；已运行 → 仅并入读取计划；占用中 → 暂缓
        assert.strictEqual(recorderResumeAction(resumed, { samplingRunning: false, occupationActive: false }), "start");
        assert.strictEqual(recorderResumeAction(resumed, { samplingRunning: true }), "refresh");
        assert.strictEqual(recorderResumeAction(resumed, { occupationActive: true }), "defer");
        assert.strictEqual(recorderResumeAction(null, {}), null);
        assert.strictEqual(recorderResumeAction({ recordingActive: false }, {}), null);

        // 轻量 harness：复刻 mainViewProvider 构造期 whenReady() 采纳回调的动作序列
        const clock = makeFakeClock();
        const fired = [];
        const scheduler = createReconnectScheduler({ clock, onFire: (attempt) => fired.push(attempt) });
        const adopt = (state, options) => {
            // 复刻采纳回调：先取得 'recorder' 所有权，再按决策启动/刷新/暂缓
            const action = recorderResumeAction(resumed, options);
            state.owners.add("recorder");
            if (action === "start") {
                state.startCalls += 1;
                if (options.startFails) {
                    // 启动失败（硬件不可用）：不硬重试，退避调度（noteRetryScheduled）接手
                    state.retries.push(scheduler.schedule());
                }
            } else if (action === "refresh") state.refreshCalls += 1;
            state.statusPosts += 1;
            return state;
        };
        const makeState = () => ({ owners: new Set(), startCalls: 0, refreshCalls: 0, retries: [], statusPosts: 0 });

        // 采样未运行且无占用 → 启动路径被调用，所有者含 'recorder'
        const auto = adopt(makeState(), { samplingRunning: false, occupationActive: false });
        assert.strictEqual(auto.startCalls, 1);
        assert.ok(auto.owners.has("recorder"));
        assert.strictEqual(auto.retries.length, 0);

        // 采样已运行 → 不重复启动，仅刷新读取计划
        const running = adopt(makeState(), { samplingRunning: true });
        assert.strictEqual(running.startCalls, 0);
        assert.strictEqual(running.refreshCalls, 1);
        assert.ok(running.owners.has("recorder"));

        // 显式占用进行中（下载/调试切换）→ 暂缓启动，占用释放后的立即重连接手
        const deferred = adopt(makeState(), { occupationActive: true });
        assert.strictEqual(deferred.startCalls, 0);
        assert.ok(deferred.owners.has("recorder"));

        // 硬件不可用（启动失败）→ 保持 pending：退避 1s 档位调度，假计时器到点触发重连
        const failed = adopt(makeState(), { samplingRunning: false, startFails: true });
        assert.strictEqual(failed.startCalls, 1);
        assert.strictEqual(failed.retries.length, 1);
        assert.strictEqual(failed.retries[0].delayMs, 1000);
        assert.ok(failed.retries[0].nextAtMs > 0);
        clock.advance(1000);
        assert.deepStrictEqual(fired, [1]);
    }
    console.log("resume adoption auto-start ok");

    // ---- pause 语义：shouldPauseSampling() true 时不调用 ingestSample（stub 验证）----
    {
        const schema = {
            variables: [{ name: "a", type: "u32", address: "0x20000000", size: 4 }],
            startTimeMs: 0,
            source: "recorder"
        };
        const samples = [{ name: "a", bytes: new Uint8Array([1, 0, 0, 0]) }];
        const harness = makeFeedHarness(schema, new Set(["recorder"]));
        harness.stubService.paused = true;
        assert.strictEqual(harness.feed(samples, 100), null);
        assert.strictEqual(harness.calls.ingests.length, 0);
        assert.strictEqual(harness.calls.pauses, 1);
        harness.stubService.paused = false;
        const built = harness.feed(samples, 200);
        assert.ok(built);
        assert.strictEqual(harness.calls.ingests.length, 1);
        assert.strictEqual(harness.calls.ingests[0].meta.source, "recorder");
        // 写队列排空后自动恢复：无活动 schema 时不喂
        assert.strictEqual(makeFeedHarness(null, new Set()).feed(samples, 300), null);
    }
    console.log("pause semantics ok");

    // ---- 端到端：真实 recordingService + buildRecorderSample 喂入（meta 映射到 NDJSON 行）----
    {
        const root = makeTempRoot("emberprobe-rec-sampling-");
        try {
            const context = makeContext(root);
            const variables = [{ name: "temp", type: "u32", address: "0x20000000", size: 4 }];
            const service = createRecordingService({
                context,
                resolveVariables: async (names) =>
                    names.map((name) => variables.find((v) => v.name === name) || { name, type: null, address: null, size: null }),
                elfInfo: async () => ({ sha256: "cd".repeat(32), mtimeMs: 111 }),
                hardwareInfo: async () => ({ mcu: "STM32F407VG", probe: "stlink-v2-1.cfg" }),
                getSamplingInterval: () => 100,
                limits: { maxMiB: 8, globalMaxMiB: 16 }
            });
            await service.whenReady();
            const started = await service.start({ names: ["temp"], intervalMs: 100 });
            assert.strictEqual(started.status, "recording");
            const schema = {
                variables: started.fixedVariables,
                startTimeMs: started.createdAtMs,
                source: "graph"
            };
            const built = buildRecorderSample(schema, [{ name: "temp", bytes: new Uint8Array([0x2a, 0, 0, 0]) }], started.createdAtMs + 250);
            assert.deepStrictEqual(built.values, ["42"]);
            assert.strictEqual(built.meta.source, "graph");
            const result = await service.ingestSample(built.values, built.meta);
            assert.strictEqual(result.written, true);

            // 全失败样本：complete:false → full:false 的整行空值样本仍写入
            const empty = buildRecorderSample(schema, [{ name: "temp", bytes: null }], started.createdAtMs + 350);
            await service.ingestSample(empty.values, empty.meta);

            const recordingsRoot = path.join(root, "recordings");
            const wsDir = path.join(recordingsRoot, fs.readdirSync(recordingsRoot)[0]);
            const dataDir = path.join(
                wsDir,
                fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.endsWith(".eprec"))[0].name
            );
            const lines = readNdjsonLines(dataDir);
            const sampleLines = lines.filter((line) => line.kind === undefined);
            assert.strictEqual(sampleLines.length, 2);
            assert.strictEqual(sampleLines[0].src, "graph");
            assert.strictEqual(sampleLines[0].full, true);
            assert.deepStrictEqual(sampleLines[0].v, ["42"]);
            assert.strictEqual(sampleLines[1].full, false);
            assert.deepStrictEqual(sampleLines[1].v, [null]);

            const stopped = await service.stop();
            assert.strictEqual(stopped.status, "completed");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
    console.log("end-to-end ingest via recordingService ok");

    console.log("recording-sampling: all tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});

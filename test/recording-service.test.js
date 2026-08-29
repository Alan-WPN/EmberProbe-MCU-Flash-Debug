"use strict";

/**
 * recordingService 会话编排层测试。
 *
 * 全部使用注入替身（临时目录 + 假 resolveVariables/elfInfo/hardwareInfo），
 * 不依赖 VS Code API、OpenOCD 或真实探针。慢磁盘/EIO 通过包装
 * recordingStorage 的 _io.writeFd 注入；配额通过 quotaManager 替身注入。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
    WRITE_QUEUE_HIGH_WATERMARK_BYTES,
    WRITE_QUEUE_HARD_MAX_BYTES,
    WRITE_QUEUE_LOW_WATERMARK_BYTES,
    createQuotaManager,
    createSession,
    readManifest,
    sessionDirFor,
    workspaceHash,
    _io: storageIo
} = require("../src/services/recordingStorage");
const { createRecordingService } = require("../src/services/recordingService");

const fsp = fs.promises;
const MIB = 1024 * 1024;

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

function makeFakes(overrides = {}) {
    const variables = overrides.variables || [
        { name: "temp", type: "float", address: "0x20000000", size: 4 },
        { name: "mode", type: "uint32_t", address: "0x20000004", size: 4 }
    ];
    const sha256 = overrides.sha256 || "ab".repeat(32);
    const mcu = overrides.mcu || "STM32F407VG";
    const probe = overrides.probe || "probe-lia-001";
    return {
        variables,
        sha256,
        mcu,
        probe,
        resolveVariables: async (names) =>
            (Array.isArray(names) ? names : []).map((name) => {
                const found = variables.find((variable) => variable.name === name);
                return found ? { ...found } : { name, type: null, address: null, size: null };
            }),
        elfInfo: async () => ({ sha256, mtimeMs: 111 }),
        hardwareInfo: async () => ({ mcu, probe })
    };
}

function makeService(root, fakes, extra = {}) {
    return createRecordingService({
        context: makeContext(root),
        resolveVariables: fakes.resolveVariables,
        elfInfo: fakes.elfInfo,
        hardwareInfo: fakes.hardwareInfo,
        getSamplingInterval: () => 100,
        limits: { maxMiB: 64, globalMaxMiB: 128 },
        ...extra
    });
}

function workspaceDirFor(root, context) {
    return path.join(root, "recordings", workspaceHash(context.storageUri.fsPath));
}

function sessionDirForId(root, context, recordingId) {
    return path.join(workspaceDirFor(root, context), `${recordingId}.eprec`);
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

/** 慢磁盘注入：每次 writeFd 延迟 delayMs（真实写入保留）。返回恢复函数。 */
function injectSlowWrite(delayMs) {
    const original = storageIo.writeFd;
    storageIo.writeFd = async (fd, buffer) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return original(fd, buffer);
    };
    return () => {
        storageIo.writeFd = original;
    };
}

/**
 * EIO 注入：仅对活动段的样本写入失败（manifest 原子写不受影响，错误日志可持久化）。
 * 段写入的行包含 "seq":，manifest 美化 JSON 中只有 "sequenceCounter":，可据此区分。
 * 第 failAfter 次段写入开始抛 EIO。返回恢复函数。
 */
function injectEioWriteOnSegments(failAfter = 1) {
    const original = storageIo.writeFd;
    const state = { segmentCalls: 0 };
    storageIo.writeFd = async (fd, buffer) => {
        if (buffer.includes('"seq":')) {
            state.segmentCalls += 1;
            if (state.segmentCalls > failAfter) {
                const error = new Error("simulated EIO");
                error.code = "EIO";
                throw error;
            }
        }
        return original(fd, buffer);
    };
    return () => {
        storageIo.writeFd = original;
    };
}

/** 轮询等待条件成立。 */
async function waitFor(predicate, timeoutMs = 5000, stepMs = 10) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await predicate()) return true;
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
}

/** 读取会话目录当前活动 .part（或唯一数据文件）的 NDJSON 行（JSON 数组）。 */
async function readNdjsonLines(sessionDir) {
    const entries = await fsp.readdir(sessionDir);
    const lines = [];
    for (const entry of entries.filter((name) => name.endsWith(".ndjson.part")).sort()) {
        const text = await fsp.readFile(path.join(sessionDir, entry), "utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    for (const entry of entries.filter((name) => name.endsWith(".ndjson.gz")).sort()) {
        const text = zlib.gunzipSync(await fsp.readFile(path.join(sessionDir, entry))).toString("utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    return lines;
}

/** 深度收集对象全部键名；断言绝不出现样本正文类键。 */
function collectKeys(value, into = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) collectKeys(item, into);
        return into;
    }
    if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            into.add(key);
            collectKeys(child, into);
        }
    }
    return into;
}

function assertMetadataOnly(snapshots) {
    const keys = collectKeys(snapshots);
    for (const forbidden of ["v", "valueText", "values", "samples", "src", "full", "seq", "ts", "el"]) {
        assert.ok(!keys.has(forbidden), `metadata must not contain sample content key: ${forbidden}`);
    }
}

// -------------------------------------------------------------------- 测试主体

(async () => {
    assert.strictEqual(WRITE_QUEUE_HIGH_WATERMARK_BYTES, 8 * MIB);
    assert.strictEqual(WRITE_QUEUE_HARD_MAX_BYTES, 16 * MIB);
    assert.strictEqual(WRITE_QUEUE_LOW_WATERMARK_BYTES, 4 * MIB);
    console.log("write queue constants ok");

    // ---- start/stop：manifest 字段、RECORDING_ACTIVE、幂等 stop、停止后拒绝写入 ----
    const rootA = makeTempRoot("emberprobe-recsvc-a-");
    try {
        const contextA = makeContext(rootA);
        const fakesA = makeFakes();
        const service = makeService(rootA, fakesA, { context: contextA });
        await service.whenReady();

        const started = await service.start({ names: ["temp", "mode"], intervalMs: 42 });
        assert.strictEqual(started.status, "recording");
        assert.strictEqual(started.recordingActive, true);
        assert.strictEqual(started.resumed, false);
        const recordingId = started.recordingId;

        // manifest 含 elfSha256 / hardware / intervalMs / fixedVariables / workspacePath。
        const manifest = await readManifest(sessionDirForId(rootA, contextA, recordingId));
        assert.strictEqual(manifest.elfSha256, "ab".repeat(32));
        assert.deepStrictEqual(manifest.hardware, { mcu: "STM32F407VG", probe: "probe-lia-001" });
        assert.strictEqual(manifest.intervalMs, 42);
        assert.strictEqual(manifest.targetIntervalMs, 42);
        assert.strictEqual(manifest.workspacePath, contextA.storageUri.fsPath);
        assert.ok(Array.isArray(manifest.fixedVariables) && manifest.fixedVariables.length === 2);
        assert.deepStrictEqual(manifest.fixedVariables[0], {
            name: "temp",
            type: "float",
            address: "0x20000000",
            size: 4
        });

        // 重复 start → RECORDING_ACTIVE。
        await assert.rejects(service.start({ names: ["temp"] }), (error) => error.code === "RECORDING_ACTIVE");

        // 采样写入（固定 schema 顺序）。
        for (let index = 0; index < 3; index += 1) {
            const result = await service.ingestSample([`1.${index}`, "7"], {
                tMs: 1000 + index * 42,
                elapsedMs: index * 42
            });
            assert.strictEqual(result.written, true);
            assert.strictEqual(result.seq, index + 1);
        }
        const liveStatus = service.status();
        assert.strictEqual(liveStatus.rows, 3);
        assert.ok(liveStatus.bytes > 0);

        // stop 幂等；stop 后 status 为 completed；append 在 stop 后被拒绝。
        const stopped = await service.stop();
        assert.strictEqual(stopped.status, "completed");
        assert.strictEqual(stopped.recordingActive, false);
        assert.strictEqual(stopped.endedAtMs != null, true);
        const stoppedAgain = await service.stop();
        assert.strictEqual(stoppedAgain.status, "completed");
        assert.strictEqual((await readManifest(sessionDirForId(rootA, contextA, recordingId))).status, "completed");
        const rejected = await service.ingestSample(["1", "2"]);
        assert.strictEqual(rejected.written, false);
        // 停止后再 start 应当可用（新会话）。
        const second = await service.start({ names: ["temp"], intervalMs: 42 });
        assert.strictEqual(second.status, "recording");
        assert.notStrictEqual(second.recordingId, recordingId);
        await service.stop();
        console.log("start/stop lifecycle ok");

        // ---- delete：未确认拒绝、活动会话拒绝、确认后目录消失且全局统计扣减 ----
        const rootB = makeTempRoot("emberprobe-recsvc-b-");
        try {
            const contextB = makeContext(rootB);
            const fakesB = makeFakes();
            const serviceB = makeService(rootB, fakesB, { context: contextB });
            await serviceB.whenReady();
            const startedB = await serviceB.start({ names: ["temp"], intervalMs: 50 });
            const idB = startedB.recordingId;
            await serviceB.ingestSample(["1.5"]);
            await serviceB.stop();

            const dirB = sessionDirForId(rootB, contextB, idB);
            assert.ok(fs.existsSync(dirB));

            await assert.rejects(serviceB.delete(idB, {}), (error) => error.code === "CONFIRMATION_REQUIRED");
            await assert.rejects(serviceB.delete(idB), (error) => error.code === "CONFIRMATION_REQUIRED");
            await assert.rejects(
                serviceB.delete(idB.replace(/.$/, "x"), { confirmed: true }),
                (error) => error.code === "RECORDING_NOT_FOUND"
            );
            await assert.rejects(
                serviceB.delete("../../escape", { confirmed: true }),
                (error) => error.code === "RECORDING_NOT_FOUND"
            );

            // 活动会话必须先 stop。
            const activeB = await serviceB.start({ names: ["temp"], intervalMs: 50 });
            await serviceB.ingestSample(["9.9"]);
            await assert.rejects(
                serviceB.delete(activeB.recordingId, { confirmed: true }),
                (error) => error.code === "RECORDING_ACTIVE"
            );
            await serviceB.stop();
            const remainingId = activeB.recordingId;
            const remainingDir = sessionDirForId(rootB, contextB, remainingId);

            // 删除前的磁盘基准（两个会话都在）。
            const quotaFull = createQuotaManager({ storageRoot: path.join(rootB, "recordings") });
            const statsFull = await quotaFull.stats();
            assert.ok(statsFull.global > 0, "session bytes must be tracked globally before deletion");

            const deleted = await serviceB.delete(idB, { confirmed: true });
            assert.deepStrictEqual(deleted, { deleted: idB });
            assert.ok(!fs.existsSync(dirB), "session directory must be removed after confirmed delete");
            // 全局统计扣减：删除后从磁盘重建的统计只包含仍存在的另一个会话。
            const quotaAfter = createQuotaManager({ storageRoot: path.join(rootB, "recordings") });
            const statsAfter = await quotaAfter.stats();
            let remainingBytes = 0;
            for (const entry of fs.readdirSync(remainingDir, { withFileTypes: true })) {
                if (entry.isFile()) remainingBytes += fs.statSync(path.join(remainingDir, entry.name)).size;
            }
            assert.strictEqual(statsAfter.global, remainingBytes);
            assert.ok(statsAfter.global < statsFull.global, "global quota stats must drop after deletion");
            const itemsB = await serviceB.list();
            assert.ok(!itemsB.some((item) => item.recordingId === idB));
            assert.ok(itemsB.some((item) => item.recordingId === remainingId));
            console.log("delete confirmation and quota accounting ok");
        } finally {
            fs.rmSync(rootB, { recursive: true, force: true });
        }
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
    }

    // ---- list/status 元数据：绝不含样本正文/valueText 键 ----
    const rootC = makeTempRoot("emberprobe-recsvc-c-");
    try {
        const service = makeService(rootC, makeFakes());
        await service.whenReady();
        const started = await service.start({ names: ["temp", "mode"], intervalMs: 50 });
        await service.ingestSample(["23.5", "0x2A"]);
        const liveList = await service.list();
        assert.strictEqual(liveList.length, 1);
        assert.deepStrictEqual(Object.keys(liveList[0]).sort(), [
            "bytes",
            "createdAtMs",
            "endedAtMs",
            "fixedVariables",
            "gaps",
            "quota",
            "recordingId",
            "retries",
            "rows",
            "status"
        ]);
        assertMetadataOnly(liveList);
        assertMetadataOnly([service.status()]);
        await service.stop();
        const doneList = await service.list();
        assert.deepStrictEqual(Object.keys(doneList[0]).sort(), [
            "bytes",
            "createdAtMs",
            "endedAtMs",
            "fixedVariables",
            "gaps",
            "quota",
            "recordingId",
            "retries",
            "rows",
            "status"
        ]);
        assert.strictEqual(doneList[0].rows, 1);
        assert.ok(doneList[0].bytes > 0);
        assertMetadataOnly(doneList);
        assertMetadataOnly([service.status()]);
        assert.strictEqual(service.status().status, "completed");
        // 无会话的新实例：{status:"none"}（同步快照；已完成会话不是恢复候选）。
        const fresh = makeService(rootC, makeFakes());
        assert.strictEqual(fresh.status().status, "none");
        await fresh.whenReady();
        assert.strictEqual(fresh.status().status, "none");
        // list() 后最近会话快照复用（历史会话从磁盘读取）。
        await fresh.list();
        assert.strictEqual(fresh.status().status, "completed");
        assert.strictEqual(fresh.status().rows, 1);
        console.log("list/status metadata-only ok");
    } finally {
        fs.rmSync(rootC, { recursive: true, force: true });
    }

    // ---- 断连 gap：恰好两条事件行、无空样本、manifest retry/gap 状态 ----
    const rootD = makeTempRoot("emberprobe-recsvc-d-");
    try {
        const contextD = makeContext(rootD);
        const service = makeService(rootD, makeFakes(), { context: contextD });
        await service.whenReady();
        const started = await service.start({ names: ["temp", "mode"], intervalMs: 50 });
        const id = started.recordingId;
        for (let index = 0; index < 3; index += 1) {
            await service.ingestSample([`${index}.5`, "1"]);
        }
        const linesBefore = await readNdjsonLines(sessionDirForId(rootD, contextD, id));
        const samplesBefore = linesBefore.filter((line) => line.kind === undefined).length;
        assert.strictEqual(samplesBefore, 3);

        await service.noteProbeDisconnected();
        await service.noteProbeDisconnected(); // 重复断连必须被忽略（一段断开只有一对事件）
        await service.noteRetryScheduled({ attempt: 2, nextAtMs: 4321 });
        await service.noteProbeReconnected();
        await service.noteProbeReconnected(); // 重复恢复为 no-op

        const linesAfter = await readNdjsonLines(sessionDirForId(rootD, contextD, id));
        const events = linesAfter.filter((line) => line.kind === "recording-event");
        assert.strictEqual(events.length, 2, "exactly gap-start and gap-end event lines expected");
        assert.strictEqual(events[0].event, "gap-start");
        assert.strictEqual(typeof events[0].ts, "number");
        assert.strictEqual(typeof events[0].atMs, "number");
        assert.strictEqual(events[1].event, "gap-end");
        assert.strictEqual(typeof events[1].durationMs, "number");
        assert.ok(events[1].durationMs >= 0);
        const samplesAfter = linesAfter.filter((line) => line.kind === undefined);
        assert.strictEqual(samplesAfter.length, 3, "no sample rows may be fabricated during disconnect");
        assert.ok(
            samplesAfter.every((line) => line.v.some((value) => value !== null)),
            "no all-null empty sample rows"
        );

        const manifestD = await readManifest(sessionDirForId(rootD, contextD, id));
        assert.deepStrictEqual(manifestD.retry.attempt, 2);
        assert.strictEqual(manifestD.retry.nextAtMs, 4321);
        assert.strictEqual(typeof manifestD.retry.updatedAtMs, "number");
        assert.strictEqual(manifestD.gapCount, 1);
        await service.stop();
        console.log("disconnect gap events ok");
    } finally {
        fs.rmSync(rootD, { recursive: true, force: true });
    }

    // ---- 扩展重启恢复：匹配续录 seq 连续；ELF/变量/硬件变化 → paused-config ----
    // 匹配续录。
    {
        const root = makeTempRoot("emberprobe-recsvc-e1-");
        try {
            const context = makeContext(root);
            const fakes = makeFakes();
            const serviceA = makeService(root, fakes, { context });
            await serviceA.whenReady();
            await serviceA.start({ names: ["temp", "mode"], intervalMs: 50 });
            for (let index = 0; index < 3; index += 1) {
                await serviceA.ingestSample([`${index}`, "2"]);
            }
            // serviceA 不 stop，模拟扩展重启（崩溃/强制退出）。
            const serviceB = makeService(root, fakes, { context });
            const resumedStatus = await serviceB.whenReady();
            assert.strictEqual(resumedStatus.status, "recording");
            assert.strictEqual(resumedStatus.resumed, true);
            assert.strictEqual(resumedStatus.rows, 3);
            const next = await serviceB.ingestSample(["3", "2"]);
            assert.deepStrictEqual(next, { written: true, seq: 4 });
            const lines = await readNdjsonLines(sessionDirForId(root, context, resumedStatus.recordingId));
            assert.deepStrictEqual(
                lines.filter((line) => line.kind === undefined).map((line) => line.seq),
                [1, 2, 3, 4]
            );
            await serviceB.stop();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    /** 构造一个"被遗弃的未完成会话"（录制 3 条后不 stop，模拟崩溃）。 */
    async function seedUnfinishedSession(root, fakes, overrides = {}) {
        const context = makeContext(root);
        const seeder = makeService(root, fakes, { context, ...overrides });
        await seeder.whenReady();
        const started = await seeder.start({ names: ["temp", "mode"], intervalMs: 50 });
        for (let index = 0; index < 3; index += 1) {
            await seeder.ingestSample([`${index}`, "2"]);
        }
        return { context, recordingId: started.recordingId };
    }

    // ELF 变化 → paused-config 且原数据完整；start 开新录制。
    {
        const root = makeTempRoot("emberprobe-recsvc-e2-");
        try {
            const fakes = makeFakes();
            const { context, recordingId } = await seedUnfinishedSession(root, fakes);
            const service = makeService(root, makeFakes({ sha256: "cd".repeat(32) }), { context });
            const paused = await service.whenReady();
            assert.strictEqual(paused.recordingActive, false);
            assert.strictEqual(paused.pausedConfigReason, "elf-changed");
            assert.strictEqual(paused.status, "paused-config");
            const manifest = await readManifest(sessionDirForId(root, context, recordingId));
            assert.strictEqual(manifest.status, "paused-config");
            assert.strictEqual(manifest.pausedConfigReason, "elf-changed");
            const lines = await readNdjsonLines(sessionDirForId(root, context, recordingId));
            assert.strictEqual(lines.filter((line) => line.kind === undefined).length, 3, "data must be preserved");
            const freshStart = await service.start({ names: ["temp", "mode"], intervalMs: 50 });
            assert.notStrictEqual(freshStart.recordingId, recordingId);
            assert.strictEqual(freshStart.pausedConfigReason, null);
            await service.stop();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    // 变量地址变化 → paused-config。
    {
        const root = makeTempRoot("emberprobe-recsvc-e3-");
        try {
            const fakes = makeFakes();
            const { context } = await seedUnfinishedSession(root, fakes);
            const service = makeService(
                root,
                makeFakes({
                    variables: [
                        { name: "temp", type: "float", address: "0x20000000", size: 4 },
                        { name: "mode", type: "uint32_t", address: "0x20000104", size: 4 }
                    ]
                }),
                { context }
            );
            const paused = await service.whenReady();
            assert.strictEqual(paused.pausedConfigReason, "variables-changed");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    // 变量类型变化 → paused-config。
    {
        const root = makeTempRoot("emberprobe-recsvc-e4-");
        try {
            const fakes = makeFakes();
            const { context } = await seedUnfinishedSession(root, fakes);
            const service = makeService(
                root,
                makeFakes({
                    variables: [
                        { name: "temp", type: "uint16_t", address: "0x20000000", size: 2 },
                        { name: "mode", type: "uint32_t", address: "0x20000004", size: 4 }
                    ]
                }),
                { context }
            );
            const paused = await service.whenReady();
            assert.strictEqual(paused.pausedConfigReason, "variables-changed");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }

    // 硬件变化 → paused-config。
    {
        const root = makeTempRoot("emberprobe-recsvc-e5-");
        try {
            const fakes = makeFakes();
            const { context } = await seedUnfinishedSession(root, fakes);
            const service = makeService(root, makeFakes({ probe: "probe-other-002" }), { context });
            const paused = await service.whenReady();
            assert.strictEqual(paused.pausedConfigReason, "hardware-changed");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
    console.log("restart recovery matching ok");

    // ---- 存储层写队列（小水位注入）：高水位 → 排空恢复 + 内部恢复事件 ----
    const rootF = makeTempRoot("emberprobe-recsvc-f-");
    let restoreSlow = null;
    try {
        restoreSlow = injectSlowWrite(25);
        const clockF = makeFakeClock();
        const session = await createSession({
            storageRoot: rootF,
            workspacePath: "/queue-ws",
            recordingId: "rec-high",
            fixedVariables: [{ name: "x", type: "float", address: "0x20000000" }],
            clock: clockF,
            writeQueueHighWatermarkBytes: 600,
            writeQueueHardMaxBytes: 4800,
            writeQueueLowWatermarkBytes: 300
        });
        const pending = [];
        for (let index = 0; index < 15; index += 1) {
            pending.push(session.appendSampleLine({ values: ["1.25"] }));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(session.backpressure, "high", "backlog must reach the high watermark");
        await session.flush();
        assert.strictEqual(session.backpressure, "none", "queue must drain back to none");
        const linesF = await readNdjsonLines(session.sessionDir);
        const seqLines = linesF.filter((line) => line.kind === undefined);
        assert.strictEqual(seqLines.length, 15);
        const resumes = linesF.filter(
            (line) => line.kind === "recording-event" && line.event === "backpressure-resume"
        );
        assert.strictEqual(resumes.length, 1, "one internal resume event expected after drain");
        assert.strictEqual(typeof resumes[0].pausedMs, "number");
        await session.close({ status: "completed" });
        await Promise.all(pending);
        console.log("write queue high watermark ok");
    } finally {
        if (restoreSlow) restoreSlow();
        fs.rmSync(rootF, { recursive: true, force: true });
    }

    // ---- 存储层写队列：硬上限拒绝 written:false，且已入队样本最终全部落盘 ----
    const rootG = makeTempRoot("emberprobe-recsvc-g-");
    restoreSlow = null;
    try {
        restoreSlow = injectSlowWrite(25);
        const clockG = makeFakeClock();
        const session = await createSession({
            storageRoot: rootG,
            workspacePath: "/queue-ws",
            recordingId: "rec-full",
            fixedVariables: [{ name: "x", type: "float", address: "0x20000000" }],
            clock: clockG,
            writeQueueHighWatermarkBytes: 600,
            writeQueueHardMaxBytes: 1200,
            writeQueueLowWatermarkBytes: 300
        });
        const pending = [];
        for (let index = 0; index < 100; index += 1) {
            pending.push(session.appendSampleLine({ values: ["1.25"] }));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(session.backpressure, "full", "queue must reach the hard cap");
        await session.flush();
        assert.strictEqual(session.backpressure, "none");
        const results = await Promise.all(pending);
        const accepted = results.filter((result) => result.written);
        const rejected = results.filter((result) => !result.written);
        assert.strictEqual(rejected.length, 100 - accepted.length);
        assert.ok(rejected.length > 0, "appends beyond the hard cap must be rejected with written:false");
        assert.ok(rejected.every((result) => result.line === "" && typeof result.seq === "number"));
        const linesG = await readNdjsonLines(session.sessionDir);
        const seqLines = linesG.filter((line) => line.kind === undefined);
        assert.strictEqual(seqLines.length, accepted.length, "every enqueued sample must reach disk (no silent loss)");
        await session.close({ status: "completed" });
        console.log("write queue hard cap rejection ok");
    } finally {
        if (restoreSlow) restoreSlow();
        fs.rmSync(rootG, { recursive: true, force: true });
    }

    // ---- 服务层写队列：慢磁盘积压达高水位 → shouldPauseSampling；排空恢复；无静默丢失 ----
    const rootH = makeTempRoot("emberprobe-recsvc-h-");
    restoreSlow = null;
    try {
        restoreSlow = injectSlowWrite(30);
        const contextH = makeContext(rootH);
        const service = makeService(rootH, makeFakes(), { context: contextH });
        await service.whenReady();
        await service.start({ names: ["temp"], intervalMs: 20 });
        const bigValue = "7".repeat(5000); // 每行约 5 KB，2000 条 ≈ 10 MiB > 高水位 8 MiB
        const highPhase = [];
        for (let index = 0; index < 2000; index += 1) {
            highPhase.push(service.ingestSample([bigValue]));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(service.status().backpressure, "high");
        assert.strictEqual(service.shouldPauseSampling(), true, "sampling must pause at the high watermark");

        assert.ok(await waitFor(() => service.status().backpressure === "none"), "queue must drain back to none");
        assert.strictEqual(service.shouldPauseSampling(), false);

        // 继续积压越过硬上限：部分写入被拒绝（written:false），已入队样本最终全部落盘。
        const fullPhase = [];
        for (let index = 0; index < 3600; index += 1) {
            fullPhase.push(service.ingestSample([bigValue]));
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(service.status().backpressure, "full");
        assert.ok(await waitFor(() => service.status().backpressure === "none", 15000, 25), "queue must fully drain");
        const highResults = await Promise.all(highPhase);
        const fullResults = await Promise.all(fullPhase);
        assert.ok(
            highResults.every((result) => result.written),
            "high-watermark phase must accept every sample"
        );
        const rejected = fullResults.filter((result) => !result.written);
        assert.ok(rejected.length > 0, "hard-cap phase must reject some samples with written:false");
        assert.ok(rejected.every((result) => result.seq === undefined && result.reason === "rejected"));
        const acceptedCount = highResults.length + fullResults.length - rejected.length;
        const status = await service.stop();
        assert.strictEqual(status.status, "completed");
        const id = status.recordingId;
        const linesH = await readNdjsonLines(sessionDirForId(rootH, contextH, id));
        const seqLines = linesH.filter((line) => line.kind === undefined);
        assert.strictEqual(seqLines.length, acceptedCount, "no silent sample loss");
        const resumes = linesH.filter(
            (line) => line.kind === "recording-event" && line.event === "backpressure-resume"
        );
        assert.ok(resumes.length >= 1, "internal resume events must be recorded");
        console.log("service write queue backpressure ok");
    } finally {
        if (restoreSlow) restoreSlow();
        fs.rmSync(rootH, { recursive: true, force: true });
    }

    // ---- EIO 注入：安全结束 stopped-error，已有数据仍可被 list 看见 ----
    const rootI = makeTempRoot("emberprobe-recsvc-i-");
    restoreSlow = null;
    try {
        restoreSlow = injectEioWriteOnSegments(1); // 第 2 次段写入开始失败
        const contextI = makeContext(rootI);
        const safeStopEvents = [];
        const service = makeService(rootI, makeFakes(), { context: contextI });
        await service.whenReady();
        service.onSafeStop((info) => safeStopEvents.push(info));
        const started = await service.start({ names: ["temp"], intervalMs: 20 });
        const id = started.recordingId;
        const first = await service.ingestSample(["1.25"]);
        assert.strictEqual(first.written, true);
        const second = await service.ingestSample(["2.50"]);
        assert.strictEqual(second.written, false);
        assert.strictEqual(safeStopEvents.length, 1);
        assert.strictEqual(safeStopEvents[0].reason, "write-failed");
        await service.stop();
        const stoppedStatus = service.status();
        assert.strictEqual(stoppedStatus.status, "stopped-error");
        assert.strictEqual(stoppedStatus.samplingPaused, true, "sampling must stay paused after safe stop");
        const items = await service.list();
        const item = items.find((entry) => entry.recordingId === id);
        assert.ok(item, "session must remain visible in list after write failure");
        assert.strictEqual(item.status, "stopped-error");
        assert.ok(item.rows >= 1);
        const dirI = sessionDirForId(rootI, contextI, id);
        assert.ok(fs.existsSync(dirI), "session directory must be preserved");
        const linesI = await readNdjsonLines(dirI);
        assert.strictEqual(linesI.filter((line) => line.kind === undefined).length, 1, "first sample preserved");
        const manifestI = await readManifest(dirI);
        assert.strictEqual(manifestI.status, "stopped-error");
        assert.ok(manifestI.errors.some((entry) => entry.code === "write-failed"));
        assert.ok(manifestI.errors.some((entry) => entry.code === "queue-bytes-lost"));
        // 幂等：重复 stop 保持 stopped-error。
        await service.stop();
        assert.strictEqual(service.status().status, "stopped-error");
        console.log("EIO safe stop ok");
    } finally {
        if (restoreSlow) restoreSlow();
        fs.rmSync(rootI, { recursive: true, force: true });
    }

    // ---- 配额停止：limits 注入 + 配额替身在封存预留时拒绝 → stopped-quota，数据保留 ----
    const rootJ = makeTempRoot("emberprobe-recsvc-j-");
    try {
        const contextJ = makeContext(rootJ);
        const clockJ = makeFakeClock();
        // 打开新段（按 32 MiB 段上限预留）允许；封存预留（按实际段大小）拒绝。
        const fakeQuota = {
            reserve: async (dir, bytes) =>
                bytes >= MIB ? { ok: true, granted: bytes } : { ok: false, reason: "session-quota-exceeded" },
            release: async () => ({ ok: true }),
            reconcile: async () => ({ ok: true }),
            stats: async () => ({ perWorkspace: {}, global: 0, limits: {} }),
            check: async () => ({ allowed: true })
        };
        const quotaEvents = [];
        const service = makeService(rootJ, makeFakes(), {
            context: contextJ,
            clock: clockJ,
            quotaManager: fakeQuota
        });
        await service.whenReady();
        service.onQuotaStop((info) => quotaEvents.push(info));
        const started = await service.start({ names: ["temp"], intervalMs: 20 });
        const id = started.recordingId;
        assert.strictEqual(started.status, "recording");
        await service.ingestSample(["1.25"]);
        await service.ingestSample(["2.50"]);
        // 推进假时钟越过 5 分钟段龄：下一次写入触发按时间轮换 → 封存预留被配额拒绝。
        clockJ.advance(5 * 60 * 1000 + 1);
        const rejected = await service.ingestSample(["3.75"]);
        assert.strictEqual(rejected.written, false);
        assert.strictEqual(quotaEvents.length, 1);
        assert.strictEqual(quotaEvents[0].reason, "session-quota-exceeded");
        await waitFor(() => service.status().status === "stopped-quota");
        assert.strictEqual(service.status().status, "stopped-quota");
        assert.strictEqual(service.shouldPauseSampling(), true, "quota stop must keep sampling paused");
        const dirJ = sessionDirForId(rootJ, contextJ, id);
        assert.ok(fs.existsSync(dirJ), "data must be preserved after quota stop");
        const linesJ = await readNdjsonLines(dirJ);
        assert.deepStrictEqual(
            linesJ.filter((line) => line.kind === undefined).map((line) => line.v[0]),
            ["1.25", "2.50"]
        );
        const manifestJ = await readManifest(dirJ);
        assert.strictEqual(manifestJ.status, "stopped-quota");
        assert.ok(manifestJ.errors.some((entry) => entry.code === "quota-exceeded"));
        const items = await service.list();
        assert.strictEqual(items.find((entry) => entry.recordingId === id).status, "stopped-quota");
        await service.stop(); // 幂等
        assert.strictEqual(service.status().status, "stopped-quota");
        console.log("quota stop ok");
    } finally {
        fs.rmSync(rootJ, { recursive: true, force: true });
    }

    // ---- 占用跟踪与订阅管理 ----
    const rootK = makeTempRoot("emberprobe-recsvc-k-");
    try {
        const service = makeService(rootK, makeFakes());
        await service.whenReady();
        service.noteOccupation("download");
        service.noteOccupation("debug");
        assert.deepStrictEqual(service.status().occupations, ["debug", "download"]);
        service.releaseOccupation("download");
        assert.deepStrictEqual(service.status().occupations, ["debug"]);
        service.releaseOccupation("debug");
        assert.deepStrictEqual(service.status().occupations, []);
        const unsubscribe = service.onQuotaStop(() => {});
        assert.strictEqual(typeof unsubscribe, "function");
        unsubscribe();
        console.log("occupation tracking ok");
    } finally {
        fs.rmSync(rootK, { recursive: true, force: true });
    }

    console.log("Recording service tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
    FORMAT_VERSION,
    SEGMENT_MAX_AGE_MS,
    SEGMENT_MAX_BYTES,
    SYNC_INTERVAL_MS,
    resolveRecordingLimits,
    workspaceHash,
    sessionDirFor,
    createSession,
    openSession,
    recoverSession,
    readManifest,
    _io: io
} = require("../src/services/recordingStorage");

const fsp = fs.promises;

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
                const due = [...timers].filter((t) => t.at <= current).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers.delete(due);
                due.fn();
            }
        }
    };
}

// 包装真实的 fdatasync 实现：统计调用次数但保持真实落盘行为。
function spyFdatasync() {
    const original = io.fdatasync;
    const spy = {
        count: 0,
        restore: () => {
            io.fdatasync = original;
        }
    };
    io.fdatasync = async (fd) => {
        spy.count += 1;
        return original(fd);
    };
    return spy;
}

async function gunzipText(filePath) {
    return zlib.gunzipSync(await fsp.readFile(filePath)).toString("utf8");
}

async function readPartLines(partPath) {
    const text = await fsp.readFile(partPath, "utf8");
    return text === ""
        ? []
        : text
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line) => JSON.parse(line));
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-recstorage-"));
    try {
        // ---- 常量与限额校验 -------------------------------------------------
        assert.strictEqual(FORMAT_VERSION, 1);
        assert.strictEqual(SEGMENT_MAX_AGE_MS, 5 * 60 * 1000);
        assert.strictEqual(SEGMENT_MAX_BYTES, 32 * 1024 * 1024);
        assert.strictEqual(SYNC_INTERVAL_MS, 1000);
        assert.deepStrictEqual(resolveRecordingLimits(), { maxMiB: 1024, globalMaxMiB: 2048 });
        assert.deepStrictEqual(resolveRecordingLimits({ maxMiB: 10, globalMaxMiB: "huge" }), {
            maxMiB: 64,
            globalMaxMiB: 2048
        });
        assert.deepStrictEqual(resolveRecordingLimits({ maxMiB: 999999, globalMaxMiB: 999999 }), {
            maxMiB: 102400,
            globalMaxMiB: 204800
        });
        assert.deepStrictEqual(resolveRecordingLimits({ maxMiB: NaN, globalMaxMiB: null }), {
            maxMiB: 1024,
            globalMaxMiB: 2048
        });
        assert.deepStrictEqual(resolveRecordingLimits({ maxMiB: 500.9, globalMaxMiB: 1000 }), {
            maxMiB: 500,
            globalMaxMiB: 1000
        });
        console.log("recording limit clamping ok");

        // ---- NDJSON 行格式与固定列顺序 -------------------------------------
        const clockA = makeFakeClock();
        const sessionA = await createSession({
            storageRoot: root,
            workspacePath: "/demo/workspace",
            recordingId: "rec-a",
            fixedVariables: [
                { name: "temp", type: "float", address: "0x20000000" },
                { name: "spare", type: "uint32_t", address: "0x20000004" },
                { name: "mode", type: "enum", address: "0x20000008" }
            ],
            targetIntervalMs: 100,
            elfSha256: "ab".repeat(32),
            mcuId: "STM32F407VG",
            debuggerId: "probe-001",
            clock: clockA
        });
        await sessionA.appendSampleLine({ source: "live", full: true, values: ["23.5", null, "0x2A"] });
        await sessionA.appendSampleLine({ source: "agent", full: false, values: [null, "7"] });
        const partA = path.join(sessionA.sessionDir, sessionA.manifest.activeSegment.file);
        const linesA = await readPartLines(partA);
        assert.strictEqual(linesA.length, 2);
        assert.deepStrictEqual([...new Set(Object.keys(linesA[0]))].sort(), ["el", "full", "seq", "src", "ts", "v"]);
        assert.strictEqual(linesA[0].seq, 1);
        assert.strictEqual(linesA[1].seq, 2);
        assert.strictEqual(linesA[0].src, "live");
        assert.strictEqual(linesA[0].full, true);
        assert.strictEqual(linesA[1].full, false);
        assert.strictEqual(typeof linesA[0].ts, "number");
        assert.strictEqual(typeof linesA[0].el, "number");
        // 固定列按 schema 顺序：缺失值一律为 null。
        assert.deepStrictEqual(linesA[0].v, ["23.5", null, "0x2A"]);
        assert.deepStrictEqual(linesA[1].v, [null, "7", null]);
        const manifestA = await readManifest(sessionA.sessionDir);
        assert.strictEqual(manifestA.status, "recording");
        // 序号实时保存在内存，磁盘清单在封存/恢复时重算；这里验证会话内存状态。
        assert.strictEqual(sessionA.manifest.sequenceCounter, 2);
        assert.strictEqual(manifestA.elfSha256, "ab".repeat(32));
        assert.deepStrictEqual(manifestA.quota, { maxMiB: 1024, globalMaxMiB: 2048, usedBytes: 0 });
        assert.strictEqual(manifestA.activeSegment.file, "seg-000001.ndjson.part");
        await sessionA.close({ status: "interrupted" });
        console.log("ndjson line format ok");

        // ---- 按大小封存 + gzip 无损 --------------------------------------
        const sessionB = await createSession({
            storageRoot: root,
            workspacePath: "/demo/workspace",
            recordingId: "rec-b",
            fixedVariables: [{ name: "x", type: "float", address: "0x20000010" }],
            segmentMaxBytes: 400,
            clock: makeFakeClock()
        });
        const firstSegmentLines = [];
        while (sessionB.manifest.segments.length === 0) {
            const { line } = await sessionB.appendSampleLine({ source: "live", values: ["1.25"] });
            if (sessionB.manifest.segments.length === 0) firstSegmentLines.push(line);
        }
        assert.strictEqual(sessionB.manifest.segments.length, 1);
        assert.strictEqual(sessionB.manifest.segments[0].reason, "size");
        const gzB1 = path.join(sessionB.sessionDir, "seg-000001.ndjson.gz");
        assert.ok(fs.existsSync(gzB1), "sealed gzip should exist");
        assert.ok(!fs.existsSync(path.join(sessionB.sessionDir, "seg-000001.ndjson.part")), "part removed after seal");
        assert.ok(fs.existsSync(path.join(sessionB.sessionDir, "seg-000002.ndjson.part")), "next segment opened");
        // gzip 必须无损：解压后与原始行逐字节一致。
        assert.strictEqual(await gunzipText(gzB1), firstSegmentLines.join(""));
        assert.strictEqual(sessionB.manifest.segments[0].samples, firstSegmentLines.length);
        await sessionB.appendSampleLine({ source: "live", values: ["9"] });
        const entryB = await sessionB.sealActiveSegment("manual");
        assert.strictEqual(entryB.reason, "manual");
        const gzB2 = path.join(sessionB.sessionDir, "seg-000002.ndjson.gz");
        const linesB2 = (await gunzipText(gzB2))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        // 触发轮换的那条采样写入新段，随后又显式追加一条。
        assert.strictEqual(linesB2.length, 2);
        assert.deepStrictEqual(linesB2[1].v, ["9"]);
        await sessionB.close({ status: "completed" });
        assert.strictEqual((await readManifest(sessionB.sessionDir)).status, "completed");
        console.log("segment sealing by size ok");

        // ---- 按时间封存 -----------------------------------------------------
        const clockC = makeFakeClock();
        const sessionC = await createSession({
            storageRoot: root,
            workspacePath: "/demo/workspace",
            recordingId: "rec-c",
            fixedVariables: [{ name: "y" }],
            clock: clockC
        });
        await sessionC.appendSampleLine({ values: ["1"] });
        assert.strictEqual(sessionC.manifest.segments.length, 0);
        clockC.advance(SEGMENT_MAX_AGE_MS + 1);
        await sessionC.appendSampleLine({ values: ["2"] });
        assert.strictEqual(sessionC.manifest.segments.length, 1);
        assert.strictEqual(sessionC.manifest.segments[0].reason, "time");
        assert.strictEqual(sessionC.manifest.activeSegment.file, "seg-000002.ndjson.part");
        await sessionC.close({ status: "completed" });
        console.log("segment sealing by time ok");

        // ---- 封存失败时保留原始段 -------------------------------------------
        const sessionD = await createSession({
            storageRoot: root,
            workspacePath: "/demo/workspace",
            recordingId: "rec-d",
            fixedVariables: [{ name: "z" }],
            clock: makeFakeClock()
        });
        const { line: lineD1 } = await sessionD.appendSampleLine({ values: ["1"] });
        const partD = sessionD.activeFilePath;
        const tmpD = path.join(sessionD.sessionDir, "seg-000001.ndjson.gz.tmp");
        await fsp.mkdir(tmpD); // 让 gzip 临时文件写入失败
        await assert.rejects(sessionD.sealActiveSegment("manual"));
        assert.ok(fs.existsSync(partD), "original part must survive failed seal");
        assert.ok(!fs.existsSync(path.join(sessionD.sessionDir, "seg-000001.ndjson.gz")));
        // 失败后活动段恢复可写，数据仍追加到同一段。
        const { line: lineD2 } = await sessionD.appendSampleLine({ values: ["2"] });
        await fsp.rmdir(tmpD);
        await sessionD.sealActiveSegment("retry");
        assert.strictEqual(await gunzipText(path.join(sessionD.sessionDir, "seg-000001.ndjson.gz")), lineD1 + lineD2);
        assert.ok(!fs.existsSync(partD));
        await sessionD.close({ status: "completed" });
        console.log("failed seal keeps original segment ok");

        // ---- manifest 原子更新 ----------------------------------------------
        const sessionE = await createSession({
            storageRoot: root,
            workspacePath: "/demo/workspace",
            recordingId: "rec-e",
            fixedVariables: [{ name: "w" }],
            targetIntervalMs: 100,
            clock: makeFakeClock()
        });
        const originalRename = io.rename;
        io.rename = async (...args) => {
            io.rename = originalRename;
            throw new Error("simulated crash before rename");
        };
        await assert.rejects(sessionE.updateManifest({ targetIntervalMs: 250 }));
        assert.strictEqual((await readManifest(sessionE.sessionDir)).targetIntervalMs, 100);
        assert.ok(!fs.existsSync(path.join(sessionE.sessionDir, "manifest.json.tmp")), "temp manifest cleaned");
        assert.strictEqual(sessionE.manifest.targetIntervalMs, 100, "in-memory manifest rolled back");
        await sessionE.updateManifest({ targetIntervalMs: 250 });
        assert.strictEqual((await readManifest(sessionE.sessionDir)).targetIntervalMs, 250);
        await sessionE.close({ status: "interrupted" });
        console.log("atomic manifest update ok");

        // ---- 恢复：截断不完整尾行并重算序号 ----------------------------------
        const wsHash = workspaceHash("/demo/workspace");
        const crashDir = sessionDirFor(root, wsHash, "rec-crash");
        await fsp.mkdir(crashDir, { recursive: true });
        const line1 = JSON.stringify({ seq: 1, ts: 10, el: 0, src: "live", full: true, v: ["1", null] }) + "\n";
        const line2 = JSON.stringify({ seq: 2, ts: 110, el: 100, src: "live", full: true, v: [null, "2"] }) + "\n";
        const line3 = JSON.stringify({ seq: 3, ts: 210, el: 200, src: "live", full: false, v: ["3", "4"] }) + "\n";
        const fragment = '{"seq":4,"ts":310,"el":300,"src":"liv';
        await fsp.writeFile(path.join(crashDir, "seg-000001.ndjson.part"), line1 + line2 + line3 + fragment);
        const reportA = await recoverSession({ sessionDir: crashDir });
        assert.strictEqual(reportA.hadManifest, false);
        assert.strictEqual(reportA.truncated, true);
        assert.strictEqual(reportA.truncatedBytes, Buffer.byteLength(fragment, "utf8"));
        assert.strictEqual(reportA.recoveredLines, 3);
        assert.strictEqual(reportA.sequenceCounter, 3);
        assert.strictEqual(
            await fsp.readFile(path.join(crashDir, "seg-000001.ndjson.part"), "utf8"),
            line1 + line2 + line3
        );
        const manifestR = await readManifest(crashDir);
        assert.strictEqual(manifestR.status, "interrupted");
        assert.strictEqual(manifestR.formatVersion, FORMAT_VERSION);
        assert.strictEqual(manifestR.sequenceCounter, 3);
        assert.strictEqual(manifestR.activeSegment.file, "seg-000001.ndjson.part");
        assert.strictEqual(manifestR.activeSegment.samples, 3);
        // 已有 manifest 时保留更高的序号计数，并追加恢复事件。
        await fsp.writeFile(
            path.join(crashDir, "manifest.json"),
            JSON.stringify({ formatVersion: 1, status: "recording", sequenceCounter: 9, errors: [] })
        );
        await fsp.appendFile(path.join(crashDir, "seg-000001.ndjson.part"), '{"seq":10,"broken');
        const reportB = await recoverSession({ sessionDir: crashDir });
        assert.strictEqual(reportB.hadManifest, true);
        assert.strictEqual(reportB.sequenceCounter, 9);
        assert.strictEqual((await readManifest(crashDir)).status, "interrupted");
        assert.ok((await readManifest(crashDir)).errors.length >= 1);
        console.log("recovery truncation ok");

        // ---- openSession 续录 ------------------------------------------------
        const sessionF = await openSession({ sessionDir: crashDir, clock: makeFakeClock() });
        assert.strictEqual(sessionF.manifest.sequenceCounter, 9);
        const { seq: seqF } = await sessionF.appendSampleLine({ source: "live", values: ["5", "6"] });
        assert.strictEqual(seqF, 10);
        const linesF = await readPartLines(sessionF.activeFilePath);
        assert.strictEqual(linesF[linesF.length - 1].seq, 10);
        await sessionF.close({ status: "completed" });
        const manifestF = await readManifest(crashDir);
        assert.strictEqual(manifestF.status, "completed");
        assert.strictEqual(manifestF.segments.length, 1);
        assert.strictEqual(manifestF.activeSegment, null);
        const recoveredF = (await gunzipText(path.join(crashDir, "seg-000001.ndjson.gz"))).trim().split("\n");
        assert.strictEqual(recoveredF.length, 4);
        assert.strictEqual(JSON.parse(recoveredF[recoveredF.length - 1]).seq, 10);
        console.log("openSession resume ok");

        // ---- 批量 1 秒 fdatasync ---------------------------------------------
        const spy = spyFdatasync();
        try {
            const clockG = makeFakeClock();
            const sessionG = await createSession({
                storageRoot: root,
                workspacePath: "/demo/workspace",
                recordingId: "rec-sync",
                fixedVariables: [{ name: "s" }],
                clock: clockG,
                syncIntervalMs: 1000
            });
            const baseline = spy.count; // createSession 的 manifest 原子写入已计入
            await sessionG.appendSampleLine({ values: ["1"] });
            await sessionG.appendSampleLine({ values: ["2"] });
            await sessionG.appendSampleLine({ values: ["3"] });
            assert.strictEqual(spy.count, baseline, "appends must coalesce syncs until the timer fires");
            clockG.advance(1000);
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));
            assert.strictEqual(spy.count, baseline + 1, "timer fires exactly one coalesced fdatasync");
            assert.strictEqual((await readPartLines(sessionG.activeFilePath)).length, 3, "data is on disk");
            await sessionG.flush();
            assert.strictEqual(spy.count, baseline + 2, "flush forces a sync");
            await sessionG.appendSampleLine({ values: ["4"] });
            const beforeClose = spy.count;
            await sessionG.close({ status: "completed" });
            assert.ok(spy.count > beforeClose, "close forces a final sync");
        } finally {
            spy.restore();
        }
        console.log("batched fdatasync ok");

        console.log("Recording storage tests passed");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

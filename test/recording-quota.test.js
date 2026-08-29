"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
    SEGMENT_MAX_BYTES,
    QUOTA_LOCK_FILE,
    QUOTA_LOCK_STALE_MS,
    createQuotaManager,
    createSession,
    readManifest,
    workspaceHash,
    sessionDirFor
} = require("../src/services/recordingStorage");

const fsp = fs.promises;
const MIB = 1024 * 1024;

/** 同步递归统计目录大小，用于与配额管理器统计对账。 */
function dirSizeSync(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) total += dirSizeSync(child);
        else if (entry.isFile()) total += fs.statSync(child).size;
    }
    return total;
}

async function writeFileBytes(filePath, size, fill = 0x61) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, Buffer.alloc(size, fill));
}

function makeTempRoot(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

(async () => {
    // ---- 默认限额与快照结构 ------------------------------------------------
    const rootA = makeTempRoot("emberprobe-quota-a-");
    try {
        const managerA = createQuotaManager({ storageRoot: rootA });
        assert.deepStrictEqual(await managerA.stats(), {
            perWorkspace: {},
            global: 0,
            limits: { maxBytes: 1024 * MIB, globalMaxBytes: 2048 * MIB }
        });
        // 越界 maxMiB 经 resolveRecordingLimits 收敛到边界值。
        const managerClamp = createQuotaManager({ storageRoot: rootA, maxMiB: 1, globalMaxMiB: 10 ** 9 });
        assert.deepStrictEqual((await managerClamp.stats()).limits, {
            maxBytes: 64 * MIB,
            globalMaxBytes: 204800 * MIB
        });
        console.log("quota manager defaults ok");

        // ---- reserve / stats / release --------------------------------------
        const wsA = workspaceHash("/quota-ws-a");
        const dirA1 = sessionDirFor(rootA, wsA, "rec-1");
        const dirA2 = sessionDirFor(rootA, wsA, "rec-2");
        const grantedA = await managerA.reserve(dirA1, 1000);
        assert.strictEqual(grantedA.ok, true);
        assert.strictEqual(grantedA.granted, 1000);
        assert.strictEqual((await managerA.reserve(dirA2, 500)).ok, true);
        let statsA = await managerA.stats();
        assert.strictEqual(statsA.global, 1500);
        assert.deepStrictEqual(statsA.perWorkspace, { [wsA]: 1500 });
        await managerA.release(dirA1, 400);
        statsA = await managerA.stats();
        assert.strictEqual(statsA.global, 1100);
        assert.strictEqual(statsA.perWorkspace[wsA], 1100);
        // 非法请求与未知会话的 release 都以对象返回，不抛出。
        assert.strictEqual((await managerA.reserve(dirA1, -5)).reason, "quota-invalid-request");
        assert.strictEqual((await managerA.reserve(dirA1, Number.NaN)).reason, "quota-invalid-request");
        assert.strictEqual((await managerA.release(sessionDirFor(rootA, "nope-ws", "rec-x"), 100)).ok, true);
        console.log("quota reserve/release ok");

        // ---- 单会话上限拒绝与 check ------------------------------------------
        const rootB = makeTempRoot("emberprobe-quota-b-");
        try {
            const managerB = createQuotaManager({ storageRoot: rootB, maxMiB: 64 });
            const dirB = sessionDirFor(rootB, workspaceHash("/quota-ws-b"), "rec-big");
            // 恰好达到上限仍允许（超出才拒绝）。
            assert.strictEqual((await managerB.reserve(dirB, 64 * MIB)).ok, true);
            const rejectedB = await managerB.reserve(dirB, 1);
            assert.strictEqual(rejectedB.ok, false);
            assert.strictEqual(rejectedB.reason, "session-quota-exceeded");
            assert.strictEqual(rejectedB.usage.sessionBytes, 64 * MIB);
            assert.strictEqual(rejectedB.usage.maxBytes, 64 * MIB);
            const checkB = await managerB.check(dirB);
            assert.strictEqual(checkB.allowed, false);
            assert.strictEqual(checkB.reason, "session-quota-exceeded");
            await managerB.release(dirB, 64 * MIB);
            assert.strictEqual((await managerB.check(dirB)).allowed, true);
            console.log("quota session limit reject ok");

            // ---- 全局上限拒绝 + 拒绝后既有文件原样保留 ------------------------
            const rootC = makeTempRoot("emberprobe-quota-c-");
            try {
                const managerC = createQuotaManager({ storageRoot: rootC, maxMiB: 64, globalMaxMiB: 128 });
                const wsC = workspaceHash("/quota-ws-c");
                const dirC1 = sessionDirFor(rootC, wsC, "rec-1");
                const dirC2 = sessionDirFor(rootC, wsC, "rec-2");
                const dirC3 = sessionDirFor(rootC, wsC, "rec-3");
                const preservedPath = path.join(dirC3, "seg-000001.ndjson.gz");
                await writeFileBytes(preservedPath, 2048, 0x5a);
                const before = await fsp.readFile(preservedPath);
                assert.strictEqual((await managerC.reserve(dirC1, 64 * MIB)).ok, true);
                assert.strictEqual((await managerC.reserve(dirC2, 64 * MIB - 2048)).ok, true);
                const rejectedC = await managerC.reserve(dirC3, 2 * MIB);
                assert.strictEqual(rejectedC.ok, false);
                assert.strictEqual(rejectedC.reason, "global-quota-exceeded");
                assert.strictEqual(rejectedC.usage.globalBytes, 128 * MIB);
                // 拒绝后既有文件原样保留，统计不变化，绝不截断、绝不循环覆盖。
                assert.strictEqual(Buffer.compare(before, await fsp.readFile(preservedPath)), 0);
                assert.strictEqual((await managerC.stats()).global, 128 * MIB);
                const checkC = await managerC.check(dirC3);
                assert.strictEqual(checkC.allowed, false);
                assert.strictEqual(checkC.reason, "global-quota-exceeded");
                console.log("quota global limit reject ok");
            } finally {
                fs.rmSync(rootC, { recursive: true, force: true });
            }
        } finally {
            fs.rmSync(rootB, { recursive: true, force: true });
        }

        // ---- 跨进程锁：繁忙返回 quota-lock-busy，陈旧锁可接管 ----------------
        const rootD = makeTempRoot("emberprobe-quota-d-");
        try {
            const managerD = createQuotaManager({ storageRoot: rootD });
            const lockPath = path.join(rootD, QUOTA_LOCK_FILE);
            const dirD = sessionDirFor(rootD, workspaceHash("/quota-ws-d"), "rec-1");
            await fsp.writeFile(lockPath, "someone-else\n");
            const busyStart = Date.now();
            const busy = await managerD.reserve(dirD, 1000);
            assert.ok(Date.now() - busyStart < 5000, "lock contention must not wait forever");
            assert.strictEqual(busy.ok, false);
            assert.strictEqual(busy.reason, "quota-lock-busy");
            // mtime 超过 10 秒的陈旧锁被接管：reserve 成功且锁被释放时清理。
            const backdated = new Date(Date.now() - QUOTA_LOCK_STALE_MS - 2000);
            await fsp.utimes(lockPath, backdated, backdated);
            const takeover = await managerD.reserve(dirD, 1000);
            assert.strictEqual(takeover.ok, true);
            assert.strictEqual(takeover.granted, 1000);
            assert.strictEqual(fs.existsSync(lockPath), false);
            console.log("quota cross-process lock ok");
        } finally {
            fs.rmSync(rootD, { recursive: true, force: true });
        }

        // ---- 并发两个 manager：串行化成功 ------------------------------------
        const rootE = makeTempRoot("emberprobe-quota-e-");
        try {
            const managerE1 = createQuotaManager({ storageRoot: rootE, maxMiB: 64, globalMaxMiB: 128 });
            const managerE2 = createQuotaManager({ storageRoot: rootE, maxMiB: 64, globalMaxMiB: 128 });
            const wsE = workspaceHash("/quota-ws-e");
            const [r1, r2] = await Promise.all([
                managerE1.reserve(sessionDirFor(rootE, wsE, "rec-1"), 60 * MIB),
                managerE2.reserve(sessionDirFor(rootE, wsE, "rec-2"), 60 * MIB)
            ]);
            assert.strictEqual(r1.ok, true);
            assert.strictEqual(r2.ok, true);
            assert.strictEqual(r1.granted, 60 * MIB);
            assert.strictEqual(r2.granted, 60 * MIB);
            assert.strictEqual((await managerE1.stats()).global, 60 * MIB);
            console.log("quota concurrent managers serialize ok");
        } finally {
            fs.rmSync(rootE, { recursive: true, force: true });
        }

        // ---- 崩溃恢复：新实例从磁盘重建，不依赖内存陈旧值 ---------------------
        const rootF = makeTempRoot("emberprobe-quota-f-");
        try {
            const wsF1 = workspaceHash("/quota-ws-f1");
            const wsF2 = workspaceHash("/quota-ws-f2");
            const dirF1 = sessionDirFor(rootF, wsF1, "rec-1");
            const dirF2 = sessionDirFor(rootF, wsF2, "rec-2");
            await writeFileBytes(path.join(dirF1, "seg-000001.ndjson.gz"), 1000);
            await writeFileBytes(path.join(dirF2, "seg-000001.ndjson.gz"), 500);
            const crashed = createQuotaManager({ storageRoot: rootF });
            assert.strictEqual((await crashed.reserve(dirF1, 50 * MIB)).ok, true);
            // 实例被丢弃（进程崩溃）后，新实例必须从磁盘重建统计。
            const rebuilt = createQuotaManager({ storageRoot: rootF });
            const statsF = await rebuilt.stats();
            assert.strictEqual(statsF.global, 1500);
            assert.deepStrictEqual(statsF.perWorkspace, { [wsF1]: 1000, [wsF2]: 500 });
            console.log("quota crash recovery rebuild ok");
        } finally {
            fs.rmSync(rootF, { recursive: true, force: true });
        }

        // ---- reconcile：以磁盘实际用量校正统计 --------------------------------
        const rootG = makeTempRoot("emberprobe-quota-g-");
        try {
            const managerG = createQuotaManager({ storageRoot: rootG, maxMiB: 64, globalMaxMiB: 128 });
            const dirG = sessionDirFor(rootG, workspaceHash("/quota-ws-g"), "rec-1");
            assert.strictEqual((await managerG.reserve(dirG, 10 * MIB)).ok, true);
            assert.strictEqual((await managerG.stats()).global, 10 * MIB);
            const reconciledDown = await managerG.reconcile(dirG);
            assert.strictEqual(reconciledDown.ok, true);
            assert.strictEqual(reconciledDown.bytes, 0);
            assert.strictEqual((await managerG.stats()).global, 0);
            await writeFileBytes(path.join(dirG, "seg-000001.ndjson.gz"), 700);
            const reconciledUp = await managerG.reconcile(dirG);
            assert.strictEqual(reconciledUp.bytes, 700);
            assert.strictEqual((await managerG.stats()).global, 700);
            console.log("quota reconcile ok");
        } finally {
            fs.rmSync(rootG, { recursive: true, force: true });
        }

        // ---- 真实会话封存后按 .gz 实际大小校正 -------------------------------
        const rootH = makeTempRoot("emberprobe-quota-h-");
        try {
            const managerH = createQuotaManager({ storageRoot: rootH, maxMiB: 64, globalMaxMiB: 128 });
            const sessionH = await createSession({
                storageRoot: rootH,
                workspacePath: "/quota-ws-h",
                recordingId: "rec-h",
                fixedVariables: [{ name: "x", type: "float", address: "0x20000000" }],
                segmentMaxBytes: 512,
                quota: managerH
            });
            // 打开新段前按 segmentMaxBytes 预留。
            assert.ok((await managerH.stats()).global >= 512);
            for (let i = 0; i < 4; i += 1) {
                const appended = await sessionH.appendSampleLine({ source: "live", values: ["1.25"] });
                assert.strictEqual(appended.written, true);
            }
            assert.ok(await sessionH.sealActiveSegment("manual"));
            // 压缩成功后以 .gz 实际大小 reconcile：统计与磁盘完全一致。
            const statsH = await managerH.stats();
            assert.strictEqual(statsH.global, dirSizeSync(sessionH.sessionDir));
            assert.strictEqual(statsH.perWorkspace[workspaceHash("/quota-ws-h")], statsH.global);
            await sessionH.close({ status: "completed" });
            console.log("quota session seal reconcile ok");
        } finally {
            fs.rmSync(rootH, { recursive: true, force: true });
        }

        // ---- 假配额：打开新段被拒 → 回调 + 安全停止，写入不抛出 ---------------
        const rootI = makeTempRoot("emberprobe-quota-i-");
        try {
            const callsI = [];
            const fakeQuotaI = {
                reserve: async (dir, bytes) => {
                    callsI.push({ dir, bytes });
                    return { ok: false, reason: "session-quota-exceeded" };
                },
                release: async () => ({ ok: true }),
                reconcile: async () => ({ ok: true })
            };
            const eventsI = [];
            const sessionI = await createSession({
                storageRoot: rootI,
                workspacePath: "/quota-ws-i",
                recordingId: "rec-i",
                fixedVariables: [{ name: "x" }],
                quota: fakeQuotaI,
                onQuotaExceeded: (reason, result) => {
                    eventsI.push({ reason, result });
                }
            });
            assert.strictEqual(eventsI.length, 1);
            assert.strictEqual(eventsI[0].reason, "session-quota-exceeded");
            assert.strictEqual(sessionI.quotaStopReason, "session-quota-exceeded");
            assert.strictEqual(sessionI.active, null);
            assert.strictEqual(callsI.length, 1);
            assert.strictEqual(callsI[0].bytes, SEGMENT_MAX_BYTES);
            const manifestI = await readManifest(sessionI.sessionDir);
            assert.ok(manifestI.errors.some((entry) => entry.code === "quota-exceeded"));
            // 后续写入安全返回占位结果，不再触发 reserve。
            const rejectedAppend = await sessionI.appendSampleLine({ values: ["1"] });
            assert.strictEqual(rejectedAppend.written, false);
            assert.strictEqual(callsI.length, 1);
            await sessionI.close({ status: "interrupted" });
            console.log("quota session open-segment reject ok");
        } finally {
            fs.rmSync(rootI, { recursive: true, force: true });
        }

        // ---- 假配额：封存预留被拒 → 原始段原样保留，不抛出 --------------------
        const rootJ = makeTempRoot("emberprobe-quota-j-");
        try {
            const callsJ = [];
            const fakeQuotaJ = {
                reserve: async (dir, bytes) => {
                    callsJ.push({ dir, bytes });
                    return callsJ.length === 1
                        ? { ok: true, granted: bytes }
                        : { ok: false, reason: "global-quota-exceeded" };
                },
                release: async () => ({ ok: true }),
                reconcile: async () => ({ ok: true })
            };
            const eventsJ = [];
            const sessionJ = await createSession({
                storageRoot: rootJ,
                workspacePath: "/quota-ws-j",
                recordingId: "rec-j",
                fixedVariables: [{ name: "x" }],
                segmentMaxBytes: 4096,
                quota: fakeQuotaJ,
                onQuotaExceeded: (reason) => eventsJ.push(reason)
            });
            const { line: lineJ } = await sessionJ.appendSampleLine({ source: "live", values: ["2.5"] });
            const partJ = sessionJ.activeFilePath;
            const sealedJ = await sessionJ.sealActiveSegment("manual");
            assert.strictEqual(sealedJ, null);
            assert.ok(fs.existsSync(partJ), "original part must survive quota-rejected seal");
            assert.strictEqual(await fsp.readFile(partJ, "utf8"), lineJ);
            assert.ok(!fs.existsSync(path.join(sessionJ.sessionDir, "seg-000001.ndjson.gz")));
            assert.ok(!fs.existsSync(path.join(sessionJ.sessionDir, "seg-000001.ndjson.gz.tmp")));
            assert.deepStrictEqual(eventsJ, ["global-quota-exceeded"]);
            // 压缩临时文件按"封口前段大小"预留。
            assert.strictEqual(callsJ.length, 2);
            assert.strictEqual(callsJ[1].bytes, Buffer.byteLength(lineJ, "utf8"));
            assert.strictEqual(sessionJ.quotaStopReason, "global-quota-exceeded");
            const afterStop = await sessionJ.appendSampleLine({ values: ["3"] });
            assert.strictEqual(afterStop.written, false);
            assert.strictEqual(await fsp.readFile(partJ, "utf8"), lineJ);
            await sessionJ.close({ status: "interrupted" });
            console.log("quota session seal reject ok");
        } finally {
            fs.rmSync(rootJ, { recursive: true, force: true });
        }

        // ---- 真实配额端到端：封存预留超限 → 回调 + 安全停止 --------------------
        const rootK = makeTempRoot("emberprobe-quota-k-");
        try {
            const managerK = createQuotaManager({ storageRoot: rootK, maxMiB: 64, globalMaxMiB: 128 });
            const eventsK = [];
            const sessionK = await createSession({
                storageRoot: rootK,
                workspacePath: "/quota-ws-k",
                recordingId: "rec-k",
                fixedVariables: [{ name: "x" }],
                segmentMaxBytes: 64 * MIB - 4096,
                quota: managerK,
                onQuotaExceeded: (reason) => eventsK.push(reason)
            });
            assert.deepStrictEqual(eventsK, []);
            // 超大采样行确保封存预留必然越过单会话上限。
            const { line: lineK } = await sessionK.appendSampleLine({ source: "live", values: ["7".repeat(20000)] });
            assert.ok(Buffer.byteLength(lineK, "utf8") > 4096);
            const partK = sessionK.activeFilePath;
            const sealedK = await sessionK.sealActiveSegment("manual");
            assert.strictEqual(sealedK, null);
            assert.deepStrictEqual(eventsK, ["session-quota-exceeded"]);
            assert.strictEqual(sessionK.quotaStopReason, "session-quota-exceeded");
            assert.ok(fs.existsSync(partK));
            assert.strictEqual(await fsp.readFile(partK, "utf8"), lineK);
            const stoppedK = await sessionK.appendSampleLine({ values: ["2"] });
            assert.strictEqual(stoppedK.written, false);
            await sessionK.close({ status: "interrupted" });
            console.log("quota real manager session reject ok");
        } finally {
            fs.rmSync(rootK, { recursive: true, force: true });
        }

        // ---- 未注入 quota 的会话行为不变 + 失败路径 ---------------------------
        const rootL = makeTempRoot("emberprobe-quota-l-");
        try {
            const sessionL = await createSession({
                storageRoot: rootL,
                workspacePath: "/quota-ws-l",
                recordingId: "rec-l",
                fixedVariables: [{ name: "x" }]
            });
            const appendedL = await sessionL.appendSampleLine({ values: ["1"] });
            assert.strictEqual(appendedL.written, true);
            assert.strictEqual(sessionL.quotaStopReason, null);
            await sessionL.close({ status: "completed" });

            // storageRoot 不可写（是普通文件）：reserve/check 返回错误对象而不抛出。
            const blockedRoot = path.join(rootL, "not-a-dir");
            await fsp.writeFile(blockedRoot, "x");
            const managerL = createQuotaManager({ storageRoot: blockedRoot });
            const failed = await managerL.reserve(sessionDirFor(blockedRoot, "ws", "rec-1"), 1000);
            assert.strictEqual(failed.ok, false);
            assert.strictEqual(failed.reason, "quota-unavailable");
            assert.ok(failed.error);
            const checkFailed = await managerL.check(sessionDirFor(blockedRoot, "ws", "rec-1"));
            assert.strictEqual(checkFailed.allowed, false);
            assert.strictEqual(checkFailed.reason, "quota-unavailable");
            console.log("quota no-quota session and failure path ok");
        } finally {
            fs.rmSync(rootL, { recursive: true, force: true });
        }

        console.log("Recording quota tests passed");
    } finally {
        fs.rmSync(rootA, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

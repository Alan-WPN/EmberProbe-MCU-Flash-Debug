"use strict";

/**
 * recordingExport 流式 CSV 导出与清理测试。
 *
 * 全部使用临时目录构造真实会话数据（storage.createSession 写样本、手写超大段、
 * recordingService 走真实编排），不依赖 VS Code API、OpenOCD 或真实探针。
 * rename 失败通过包装 recordingExport 的 _io 注入；路径安全用缺省校验器 + 临时工作区验证。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");

const {
    createSession,
    createQuotaManager,
    readManifest,
    sessionDirFor,
    workspaceHash
} = require("../src/services/recordingStorage");
const { createRecordingService } = require("../src/services/recordingService");
const exportModule = require("../src/services/recordingExport");
const { createRecordingExporter } = exportModule;

const fsp = fs.promises;
const MIB = 1024 * 1024;
const BASE_MS = 1700000000000;

// ------------------------------------------------------------------ 工具函数

const tempRoots = [];

function makeTempRoot(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempRoots.push(dir);
    return dir;
}

function makeContext(root) {
    return {
        globalStorageUri: { fsPath: root },
        storageUri: { fsPath: path.join(root, "workspace-identity") }
    };
}

/** 注入替身服务：供"非活动会话"导出使用（status 恒为空闲）。 */
function makeStubService() {
    return { status: () => ({ recordingActive: false, recordingId: null }) };
}

function makeService(root, extra = {}) {
    return createRecordingService({
        context: makeContext(root),
        resolveVariables: async (names) =>
            (Array.isArray(names) ? names : []).map((name) => ({
                name,
                type: "float",
                address: "0x20000000",
                size: 4
            })),
        elfInfo: async () => ({ sha256: "ab".repeat(32), mtimeMs: 111 }),
        hardwareInfo: async () => ({ mcu: "STM32F407VG", probe: "probe-export-001" }),
        getSamplingInterval: () => 100,
        limits: { maxMiB: 64, globalMaxMiB: 128 },
        ...extra
    });
}

function makeExporter(service, storageRoot, workspaceRoot, extra = {}) {
    return createRecordingExporter({
        recordingService: service,
        storageRootProvider: () => storageRoot,
        workspaceRootProvider: () => workspaceRoot,
        ...extra
    });
}

function rawStorageRoot(root) {
    return path.join(root, "recordings");
}

function rawSessionDir(root, recordingId) {
    return sessionDirFor(rawStorageRoot(root), workspaceHash(path.join(root, "ws-identity")), recordingId);
}

function serviceSessionDir(root, recordingId) {
    return sessionDirFor(rawStorageRoot(root), workspaceHash(makeContext(root).storageUri.fsPath), recordingId);
}

async function pathExists(target) {
    try {
        await fsp.access(target);
        return true;
    } catch {
        return false;
    }
}

const iso = (ms) => new Date(ms).toISOString();

/** CSV 数据行 → 时间戳数组（time 列为 ISO 8601 UTC）。 */
function rowTimes(rows) {
    return rows.slice(1).map((row) => Date.parse(row.slice(0, row.indexOf(","))));
}

/** 读取 CSV 全文并按 CRLF 拆行（首行去 BOM；仅用于不含引号内换行的用例）。 */
async function readCsvRows(csvPath) {
    const text = await fsp.readFile(csvPath, "utf8");
    assert.ok(text.startsWith("\uFEFF"), "CSV must start with UTF-8 BOM");
    const rows = text.slice(1).split("\r\n");
    if (rows[rows.length - 1] === "") rows.pop(); // 末尾 CRLF
    return rows;
}

async function readNdjsonLines(sessionDir) {
    const [part, sealed] = await Promise.all([readPartLines(sessionDir), readSealedLines(sessionDir)]);
    return [...part, ...sealed];
}

/** 读取活动 .part 段的 NDJSON 行。 */
async function readPartLines(sessionDir) {
    const entries = (await fsp.readdir(sessionDir)).filter((name) => name.endsWith(".ndjson.part")).sort();
    const lines = [];
    for (const entry of entries) {
        const text = await fsp.readFile(path.join(sessionDir, entry), "utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    return lines;
}

/** 读取已封存 .gz 段的 NDJSON 行。 */
async function readSealedLines(sessionDir) {
    const entries = (await fsp.readdir(sessionDir)).filter((name) => name.endsWith(".ndjson.gz")).sort();
    const lines = [];
    for (const entry of entries) {
        const text = zlib.gunzipSync(await fsp.readFile(path.join(sessionDir, entry))).toString("utf8");
        for (const line of text.split("\n")) if (line) lines.push(JSON.parse(line));
    }
    return lines;
}

/**
 * 用 storage.createSession 构造一个真实会话：actions 为采样（{ts, values}）或
 * 内部事件行（{event, extra}），最后按 finalStatus 封口。
 */
async function buildSession(root, recordingId, fixedVariables, actions, finalStatus = "completed") {
    const session = await createSession({
        storageRoot: rawStorageRoot(root),
        workspacePath: path.join(root, "ws-identity"),
        recordingId,
        fixedVariables
    });
    for (const action of actions) {
        if (action.event) await session.appendEventLine(action.event, action.extra || {});
        else await session.appendSampleLine({ timestampMs: action.ts, values: action.values });
    }
    await session.close({ status: finalStatus });
    return session;
}

/**
 * 构造三段会话（段边界手工改写为可精确断言的值）：
 *   第 1 段 [100,199] 行 ts=100,110,120,130,199
 *   第 2 段 [200,299] 行 ts=200,220,240,260,280
 *   第 3 段 [300,399] 行 ts=300,310,320,330,340（corruptLast 时替换为损坏的 .gz）
 */
async function buildMultiSegmentSession(root, recordingId, { corruptLast = false } = {}) {
    const session = await createSession({
        storageRoot: rawStorageRoot(root),
        workspacePath: path.join(root, "ws-identity"),
        recordingId,
        fixedVariables: [
            { name: "a", type: "float", address: "0x20000000" },
            { name: "b", type: "float", address: "0x20000004" }
        ]
    });
    const segmentTimes = [
        [100, 110, 120, 130, 199],
        [200, 220, 240, 260, 280],
        [300, 310, 320, 330, 340]
    ];
    for (let index = 0; index < segmentTimes.length; index += 1) {
        if (index > 0) await session.sealActiveSegment("manual"); // 封存当前段，下一条样本自动开新段
        for (const ts of segmentTimes[index]) {
            await session.appendSampleLine({ timestampMs: ts, values: [String(ts), `seg${index}`] });
        }
    }
    await session.close({ status: "completed" }); // 封存最后一段
    const sessionDir = session.sessionDir;
    // 真实封口边界都是"当前时刻"，无法制造不相交窗口；手工改写边界使分段选择可精确断言。
    const manifestPath = path.join(sessionDir, "manifest.json");
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const boundaries = [
        [100, 199],
        [200, 299],
        [300, 399]
    ];
    manifest.segments.forEach((segment, index) => {
        if (boundaries[index]) {
            segment.startedAtMs = boundaries[index][0];
            segment.endedAtMs = boundaries[index][1];
        }
    });
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    if (corruptLast) {
        // 末段替换为损坏的 .gz：用于验证"读取失败"与"分段跳过后不受影响"。
        const lastSegment = manifest.segments[manifest.segments.length - 1];
        await fsp.writeFile(path.join(sessionDir, lastSegment.file), Buffer.from("this is not gzip data"));
    }
    return sessionDir;
}

/** 手写一个超大段（明文逐批写盘后流式 gzip，构造期同样不整读内存），返回行数等信息。 */
async function buildLargeSession(root, recordingId, targetBytes) {
    const sessionDir = rawSessionDir(root, recordingId);
    await fsp.mkdir(sessionDir, { recursive: true });
    const pad = "x".repeat(200);
    const line = (index) =>
        `{"seq":${index + 1},"ts":${BASE_MS + index},"el":${index},"src":"live","full":true,"v":["1.234","${pad}"]}\n`;
    const lineBytes = Buffer.byteLength(line(0), "utf8");
    const totalLines = Math.ceil(targetBytes / lineBytes);
    const plainPath = path.join(sessionDir, "seg-000000.ndjson");
    const handle = await fsp.open(plainPath, "w");
    try {
        const batch = [];
        for (let index = 0; index < totalLines; index += 1) {
            batch.push(line(index));
            if (batch.length >= 10000) {
                await handle.write(batch.join(""));
                batch.length = 0;
            }
        }
        if (batch.length > 0) await handle.write(batch.join(""));
    } finally {
        await handle.close();
    }
    const gzPath = path.join(sessionDir, "seg-000000.ndjson.gz");
    await pipeline(fs.createReadStream(plainPath), zlib.createGzip(), fs.createWriteStream(gzPath));
    await fsp.unlink(plainPath);
    const gzStat = await fsp.stat(gzPath);
    const manifest = {
        formatVersion: 1,
        status: "completed",
        createdAtMs: BASE_MS,
        startedAtMs: BASE_MS,
        endedAtMs: BASE_MS + totalLines,
        fixedVariables: [
            { name: "a", type: "float", address: "0x20000000" },
            { name: "b", type: "float", address: "0x20000004" }
        ],
        targetIntervalMs: 100,
        elfSha256: null,
        mcuId: null,
        debuggerId: null,
        sequenceCounter: totalLines,
        segments: [
            {
                name: "seg-000000",
                file: "seg-000000.ndjson.gz",
                samples: totalLines,
                bytes: totalLines * lineBytes,
                compressedBytes: gzStat.size,
                sealedAtMs: BASE_MS + totalLines,
                startedAtMs: BASE_MS,
                endedAtMs: BASE_MS + totalLines,
                reason: "close"
            }
        ],
        activeSegment: null,
        errors: [],
        quota: { maxMiB: 1024, globalMaxMiB: 2048, usedBytes: 0 }
    };
    await fsp.writeFile(path.join(sessionDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    return { sessionDir, totalLines, lineBytes };
}

// -------------------------------------------------------------------- 测试主体

(async () => {
    const stub = makeStubService();

    // ------------------------------------------------------------ 格式（BOM/CRLF/RFC4180/列序/ISO time/事件行忽略）
    {
        const root = makeTempRoot("emberprobe-export-fmt-");
        const wsRoot = makeTempRoot("emberprobe-export-fmt-ws-");
        await buildSession(
            root,
            "fmt-case",
            [
                { name: "plain", type: "float", address: "0x20000000" },
                { name: "com,ma", type: "float", address: "0x20000004" },
                { name: 'qu"ote', type: "float", address: "0x20000008" },
                { name: "new\nline", type: "float", address: "0x2000000c" }
            ],
            [
                { ts: BASE_MS + 1000, values: ["1.5", "a,b", 'say"hi', "l1\nl2"] },
                { event: "gap-start", extra: { atMs: BASE_MS + 1001 } },
                { ts: BASE_MS + 2000, values: [null, "x", null, "y"] },
                { event: "gap-end", extra: { atMs: BASE_MS + 1999, durationMs: 998 } },
                { ts: BASE_MS + 3000, values: ["3", "4", "5", "6"] }
            ]
        );
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        const result = await exporter.exportRecording({ recordingId: "fmt-case", outputPath: "fmt/all.csv" }).promise;
        assert.strictEqual(result.ok, true, `export should succeed: ${result.message}`);
        assert.strictEqual(result.rows, 3);
        assert.strictEqual(result.purged, false);
        // 与图表 CSV 完全一致的约定：BOM + CRLF + RFC 4180 转义 + ISO 8601 UTC time 列 + 末尾 CRLF。
        const expected =
            "\uFEFF" +
            [
                ["time", "plain", '"com,ma"', '"qu""ote"', '"new\nline"'].join(","),
                [iso(BASE_MS + 1000), "1.5", '"a,b"', '"say""hi"', '"l1\nl2"'].join(","),
                [iso(BASE_MS + 2000), "", "x", "", "y"].join(","),
                [iso(BASE_MS + 3000), "3", "4", "5", "6"].join(",")
            ].join("\r\n") +
            "\r\n";
        const raw = await fsp.readFile(result.outputPath, "utf8");
        assert.strictEqual(raw, expected, "CSV content must match chart-CSV conventions exactly");
        const rawBuf = await fsp.readFile(result.outputPath);
        assert.deepStrictEqual([...rawBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf], "first bytes must be UTF-8 BOM");
        assert.ok(!raw.includes("recording-event"), "kind event lines must be ignored");
        assert.ok(!raw.includes("gap-"), "gap events must not appear in export");
        // 缺失值输出空字段：第 2 行 plain 与 qu"ote 列为空（已在 expected 中断言）。
        // 表头列序 = 请求 variables 顺序（子集 + 交换顺序）。
        const subset = await exporter.exportRecording({
            recordingId: "fmt-case",
            outputPath: "fmt/sub.csv",
            variables: ["com,ma", "plain"]
        }).promise;
        assert.strictEqual(subset.ok, true);
        const rows = await readCsvRows(subset.outputPath);
        assert.strictEqual(rows[0], 'time,"com,ma",plain', "header order must follow requested variables");
        assert.strictEqual(rows[1], `${iso(BASE_MS + 1000)},"a,b",1.5`);
        assert.strictEqual(rows.length, 4);
    }

    // ------------------------------------------------------------ 筛选（变量子集/时间边界含入含出/缺失值/跨块长行）
    {
        const root = makeTempRoot("emberprobe-export-filter-");
        const wsRoot = makeTempRoot("emberprobe-export-filter-ws-");
        const longValue = "温度℃长值".repeat(400); // 多字节 + 长行：用 16 字节小块强制跨块拆分
        // 样本时间取真实墙钟附近：封存段的边界是墙钟（createdAtMs/sealedAtMs），
        // 显式时间窗口必须落在边界内才不会被分段选择跳过。
        const t0 = Date.now();
        const filterSession = await buildSession(
            root,
            "filter-case",
            [
                { name: "a", type: "float", address: "0x20000000" },
                { name: "b", type: "float", address: "0x20000004" }
            ],
            [
                { ts: t0 + 1000, values: ["1", "x"] },
                { ts: t0 + 2000, values: [null, longValue] },
                { ts: t0 + 3000, values: ["3", "y"] }
            ]
        );
        // 放宽封存段边界到全时段：本节关注行级时间筛选，分段选择交给专门用例。
        const filterManifestPath = path.join(filterSession.sessionDir, "manifest.json");
        const filterManifest = JSON.parse(await fsp.readFile(filterManifestPath, "utf8"));
        for (const segment of filterManifest.segments) {
            segment.startedAtMs = 0;
            segment.endedAtMs = 8640000000000000; // ES 时代毫秒上限
        }
        await fsp.writeFile(filterManifestPath, JSON.stringify(filterManifest, null, 2) + "\n");
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot, { readHighWaterMarkBytes: 16 });
        // [fromMs, toMs] 单点窗口：边界含入，只命中 ts=t0+2000 一行。
        const mid = await exporter.exportRecording({
            recordingId: "filter-case",
            outputPath: "mid.csv",
            fromMs: t0 + 2000,
            toMs: t0 + 2000
        }).promise;
        assert.strictEqual(mid.ok, true, mid.message);
        const midRows = await readCsvRows(mid.outputPath);
        assert.strictEqual(midRows.length, 2, "single-point window must keep exactly one data row");
        assert.strictEqual(
            midRows[1],
            `${iso(t0 + 2000)},,${longValue}`,
            "missing value must be an empty field and multibyte long line must survive chunk splits"
        );
        // 边界含入含出：fromMs 含入、toMs 不含出（t0+2999 排除 ts=t0+3000）。
        const range = await exporter.exportRecording({
            recordingId: "filter-case",
            outputPath: "range.csv",
            fromMs: t0 + 1000,
            toMs: t0 + 2999
        }).promise;
        assert.strictEqual(range.ok, true);
        assert.deepStrictEqual(rowTimes(await readCsvRows(range.outputPath)), [t0 + 1000, t0 + 2000]);
        // 全部缺省 = 全部固定变量 + 全部时间。
        const all = await exporter.exportRecording({ recordingId: "filter-case", outputPath: "all.csv" }).promise;
        assert.deepStrictEqual(rowTimes(await readCsvRows(all.outputPath)), [t0 + 1000, t0 + 2000, t0 + 3000]);
    }

    // ------------------------------------------------------------ 分段选择与段序
    {
        const root = makeTempRoot("emberprobe-export-seg-");
        const wsRoot = makeTempRoot("emberprobe-export-seg-ws-");
        const sessionDir = await buildMultiSegmentSession(root, "seg-case", { corruptLast: true });
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        const manifestPath = path.join(sessionDir, "manifest.json");
        // 窗口 [210,290]：seg0（endedAt=199 < 210）与 seg2（startedAt=300 > 290）应被跳过——
        // seg2 已损坏，若未被跳过导出必然失败；seg1 命中 4 行（220/240/260/280，边界含入含出）。
        const t1 = await exporter.exportRecording({
            recordingId: "seg-case",
            outputPath: "t1.csv",
            fromMs: 210,
            toMs: 290
        }).promise;
        assert.strictEqual(t1.ok, true, `overlapping-window export must skip non-overlapping segments: ${t1.message}`);
        assert.deepStrictEqual(rowTimes(await readCsvRows(t1.outputPath)), [220, 240, 260, 280]);
        // 全窗口 [100,399]：损坏的 seg2 被读取 → 导出失败且内部会话完好。
        const manifestBefore = await fsp.readFile(manifestPath);
        const t2 = await exporter.exportRecording({
            recordingId: "seg-case",
            outputPath: "t2.csv",
            fromMs: 100,
            toMs: 399
        }).promise;
        assert.strictEqual(t2.ok, false);
        assert.strictEqual(t2.code, "EXPORT_FAILED");
        assert.ok(!(await pathExists(path.join(wsRoot, "t2.csv"))), "failed export must not leave target file");
        assert.ok(!(await pathExists(path.join(wsRoot, "t2.csv.partial"))), "failed export must clean .partial");
        assert.ok(
            (await fsp.readFile(manifestPath)).equals(manifestBefore),
            "failed export must not touch the session"
        );
        // 边界相切视为重叠：[199,200] 同时命中 seg0（endedAt=199）与 seg1（startedAt=200）。
        const t3 = await exporter.exportRecording({
            recordingId: "seg-case",
            outputPath: "t3.csv",
            fromMs: 199,
            toMs: 200
        }).promise;
        assert.strictEqual(t3.ok, true, t3.message);
        assert.deepStrictEqual(rowTimes(await readCsvRows(t3.outputPath)), [199, 200], "tangent boundaries included");
        // 缺时间边界的段保守纳入：删除 seg2 边界后，即使窗口 [95,199] 也会读取损坏 seg2 → 失败。
        const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
        delete manifest.segments[2].startedAtMs;
        delete manifest.segments[2].endedAtMs;
        await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        const t4 = await exporter.exportRecording({
            recordingId: "seg-case",
            outputPath: "t4.csv",
            fromMs: 95,
            toMs: 199
        }).promise;
        assert.strictEqual(t4.ok, false);
        assert.strictEqual(t4.code, "EXPORT_FAILED", "boundary-less segments must be conservatively included");
        // 段序处理：按段顺序（而非时间戳）输出——seg0 的 ts=BASE+900 行先于 seg1 的 ts=BASE+100 行。
        const orderSession = await createSession({
            storageRoot: rawStorageRoot(root),
            workspacePath: path.join(root, "ws-identity"),
            recordingId: "seg-order-2",
            fixedVariables: [{ name: "v", type: "float", address: "0x20000000" }]
        });
        await orderSession.appendSampleLine({ timestampMs: BASE_MS + 900, values: ["first"] });
        await orderSession.sealActiveSegment("manual");
        await orderSession.appendSampleLine({ timestampMs: BASE_MS + 100, values: ["second"] });
        await orderSession.close({ status: "completed" });
        // 手工放宽段边界，避免真实封口时刻（墙钟）把窗口过滤复杂化——本用例只关注段序。
        const orderManifestPath = path.join(orderSession.sessionDir, "manifest.json");
        const orderManifest = JSON.parse(await fsp.readFile(orderManifestPath, "utf8"));
        for (const segment of orderManifest.segments) {
            segment.startedAtMs = 0;
            segment.endedAtMs = 8640000000000000; // ES 时代毫秒上限
        }
        await fsp.writeFile(orderManifestPath, JSON.stringify(orderManifest, null, 2) + "\n");
        const t5 = await exporter.exportRecording({ recordingId: "seg-order-2", outputPath: "order.csv" }).promise;
        assert.strictEqual(t5.ok, true);
        assert.deepStrictEqual(
            rowTimes(await readCsvRows(t5.outputPath)),
            [BASE_MS + 900, BASE_MS + 100],
            "segments must be processed in segment order, not timestamp order"
        );
    }

    // ------------------------------------------------------------ 流式内存有界 + 取消（96 MiB 大段复用）
    {
        const root = makeTempRoot("emberprobe-export-big-");
        const wsRoot = makeTempRoot("emberprobe-export-big-ws-");
        const big = await buildLargeSession(root, "big-case", 96 * MIB);
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        // 取消：半途 cancel → EXPORT_CANCELLED、.partial 清理、无目标文件、内部会话不变。
        const manifestPath = path.join(big.sessionDir, "manifest.json");
        const manifestBefore = await fsp.readFile(manifestPath);
        const handle = exporter.exportRecording({ recordingId: "big-case", outputPath: "cancel.csv" });
        setTimeout(() => handle.cancel(), 20);
        const cancelled = await handle.promise;
        assert.strictEqual(cancelled.ok, false);
        assert.strictEqual(cancelled.code, "EXPORT_CANCELLED");
        assert.ok(!(await pathExists(path.join(wsRoot, "cancel.csv"))), "cancel must not leave the target file");
        assert.ok(!(await pathExists(path.join(wsRoot, "cancel.csv.partial"))), "cancel must clean .partial");
        assert.ok((await fsp.readFile(manifestPath)).equals(manifestBefore), "cancel must not modify the session");
        // 流式：完整导出 96 MiB 段，进程 RSS 峰值增长有界（整段读入内存的实现必然超标）。
        const baseline = process.memoryUsage().rss;
        const rssSamples = [baseline];
        const timer = setInterval(() => rssSamples.push(process.memoryUsage().rss), 5);
        const startedAt = Date.now();
        const result = await exporter.exportRecording({ recordingId: "big-case", outputPath: "big.csv" }).promise;
        clearInterval(timer);
        assert.strictEqual(result.ok, true, result.message);
        assert.strictEqual(result.rows, big.totalLines, "every sample line must be exported exactly once");
        const stat = await fsp.stat(result.outputPath);
        assert.strictEqual(result.bytes, stat.size, "bytes must equal the final file size");
        const peakGrowth = Math.max(...rssSamples) - baseline;
        const elapsed = Date.now() - startedAt;
        assert.ok(
            peakGrowth < 64 * MIB,
            `streaming export RSS growth must stay under 64 MiB (got ${(peakGrowth / MIB).toFixed(1)} MiB)`
        );
        console.log(
            `    [stream] rows=${result.rows} bytes=${result.bytes} elapsed=${elapsed}ms peakRssGrowth=${(peakGrowth / MIB).toFixed(1)}MiB`
        );
        // promise 决议后再 cancel()：为 no-op，不影响已成功的结果。
        const second = exporter.exportRecording({ recordingId: "big-case", outputPath: "big2.csv" });
        const done = await second.promise;
        assert.strictEqual(done.ok, true);
        second.cancel();
        assert.strictEqual(done.ok, true, "cancel after completion must be a no-op");
    }

    // ------------------------------------------------------------ 原子性（注入 rename 失败）
    {
        const root = makeTempRoot("emberprobe-export-atomic-");
        const wsRoot = makeTempRoot("emberprobe-export-atomic-ws-");
        await buildSession(
            root,
            "atomic-case",
            [{ name: "a", type: "float", address: "0x20000000" }],
            [{ ts: 1000, values: ["1"] }]
        );
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        const sessionDir = rawSessionDir(root, "atomic-case");
        const manifestBefore = await fsp.readFile(path.join(sessionDir, "manifest.json"));
        const originalRename = exportModule._io.rename;
        exportModule._io.rename = async () => {
            throw new Error("simulated rename failure");
        };
        let result;
        try {
            result = await exporter.exportRecording({
                recordingId: "atomic-case",
                outputPath: "atomic.csv",
                purgeAfterSuccess: true,
                confirmPurge: true
            }).promise;
        } finally {
            exportModule._io.rename = originalRename;
        }
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.code, "EXPORT_FAILED");
        assert.ok(/simulated rename/.test(result.message), "rename failure message must surface");
        assert.ok(!(await pathExists(path.join(wsRoot, "atomic.csv"))), "target must never appear on failure");
        assert.ok(!(await pathExists(path.join(wsRoot, "atomic.csv.partial"))), ".partial must be cleaned");
        assert.ok(await pathExists(sessionDir), "purge must not run after a failed export");
        assert.ok(
            (await fsp.readFile(path.join(sessionDir, "manifest.json"))).equals(manifestBefore),
            "failed export must not touch the session"
        );
        assert.strictEqual((await readNdjsonLines(sessionDir)).length, 1);
    }

    // ------------------------------------------------------------ 在线导出（活动会话）
    {
        const root = makeTempRoot("emberprobe-export-online-");
        const wsRoot = makeTempRoot("emberprobe-export-online-ws-");
        const service = makeService(root);
        await service.start({ names: ["a", "b"] });
        const recordingId = service.status().recordingId;
        assert.ok(recordingId, "service must expose the active recording id");
        const sessionDir = serviceSessionDir(root, recordingId);
        // 样本时间取真实墙钟（ts ≤ 封口时刻，与生产采样一致）；封存段边界为墙钟。
        const t1 = Date.now();
        await service.ingestSample(["1", "2"], { tMs: t1 });
        const t2 = Date.now();
        await service.ingestSample(["3", "4"], { tMs: t2 });
        const exporter = makeExporter(service, rawStorageRoot(root), wsRoot);
        // 活动会话请求清理：直接拒绝（RECORDING_ACTIVE），且不得旋转/写文件。
        const refused = await exporter.exportRecording({
            recordingId,
            outputPath: "online2.csv",
            purgeAfterSuccess: true,
            confirmPurge: true
        }).promise;
        assert.strictEqual(refused.ok, false);
        assert.strictEqual(refused.code, "RECORDING_ACTIVE");
        assert.ok(!(await pathExists(path.join(wsRoot, "online2.csv"))));
        const manifestBeforeRotate = await readManifest(sessionDir);
        assert.strictEqual(manifestBeforeRotate.segments.length, 0, "refused purge must not rotate the session");
        // 在线导出：先原子旋转（封存当前段 + 开新段），以封口时刻为一致性截止点。
        const result = await exporter.exportRecording({ recordingId, outputPath: "online.csv", toMs: t1 + 88888888 })
            .promise;
        assert.strictEqual(result.ok, true, result.message);
        assert.strictEqual(result.purged, false, "online export never purges");
        const manifest = await readManifest(sessionDir);
        assert.strictEqual(manifest.segments.length, 1, "rotation must seal the previous active segment");
        assert.ok(manifest.activeSegment, "rotation must immediately open a new segment");
        assert.notStrictEqual(manifest.activeSegment.name, manifest.segments[0].name);
        assert.strictEqual(service.status().recordingActive, true, "session must keep recording after online export");
        // 截止点之后的样本进新段，不属于本次导出。
        const t4 = Date.now();
        await service.ingestSample(["5", "6"], { tMs: t4 });
        const sealedTimes = (await readSealedLines(sessionDir)).filter((line) => line.ts != null).map((l) => l.ts);
        assert.ok(sealedTimes.includes(t1) && sealedTimes.includes(t2), "sealed data intact after rotation");
        assert.ok(!sealedTimes.includes(t4), "post-cutoff sample must live in the new segment");
        const partTimes = (await readPartLines(sessionDir)).filter((line) => line.ts != null).map((l) => l.ts);
        assert.deepStrictEqual(partTimes, [t4], "post-rotation samples go to the new active segment");
        const rows = await readCsvRows(result.outputPath);
        assert.deepStrictEqual(rowTimes(rows), [t1, t2], "export must end at the cutoff even for a far-future toMs");
        assert.strictEqual(rows[1], `${iso(t1)},1,2`);
        await service.stop();
        const afterStop = await readManifest(sessionDir);
        assert.strictEqual(afterStop.status, "completed", "internal data must be fully preserved");
        assert.strictEqual((await readNdjsonLines(sessionDir)).length, 3, "no sample lost across the rotation");
    }

    // ------------------------------------------------------------ 最终导出清理（purge）
    {
        const root = makeTempRoot("emberprobe-export-purge-");
        const wsRoot = makeTempRoot("emberprobe-export-purge-ws-");
        const quota = createQuotaManager({
            storageRoot: rawStorageRoot(root),
            maxMiB: 64,
            globalMaxMiB: 128
        });
        const service = makeService(root, { quotaManager: quota });
        await service.start({ names: ["a", "b"] });
        const recordingId = service.status().recordingId;
        await service.ingestSample(["1", "2"], { tMs: BASE_MS + 10 });
        await service.stop();
        const sessionDir = serviceSessionDir(root, recordingId);
        assert.ok(await pathExists(sessionDir), "stopped session must exist before export");
        assert.ok((await quota.stats()).global > 0, "quota must account for the session");
        const exporter = makeExporter(service, rawStorageRoot(root), wsRoot);
        // confirmPurge 缺失 → CONFIRMATION_REQUIRED，且不产生任何输出。
        const unconfirmed = await exporter.exportRecording({
            recordingId,
            outputPath: "unconfirmed.csv",
            purgeAfterSuccess: true
        }).promise;
        assert.strictEqual(unconfirmed.ok, false);
        assert.strictEqual(unconfirmed.code, "CONFIRMATION_REQUIRED");
        assert.ok(!(await pathExists(path.join(wsRoot, "unconfirmed.csv"))));
        // 成功 + purge：会话目录消失、配额统计扣减。
        const result = await exporter.exportRecording({
            recordingId,
            outputPath: "final.csv",
            purgeAfterSuccess: true,
            confirmPurge: true
        }).promise;
        assert.strictEqual(result.ok, true, result.message);
        assert.strictEqual(result.purged, true, "purge must be reported");
        assert.ok(!(await pathExists(sessionDir)), "session directory must be removed after successful purge");
        assert.strictEqual((await quota.stats()).global, 0, "quota accounting must be reduced to zero");
        assert.ok(await pathExists(result.outputPath), "the exported CSV must survive the purge");
    }

    // ------------------------------------------------------------ 路径安全（缺省校验器）
    {
        const root = makeTempRoot("emberprobe-export-path-");
        const wsRoot = makeTempRoot("emberprobe-export-path-ws-");
        const outsideDir = makeTempRoot("emberprobe-export-outside-");
        await fsp.symlink(outsideDir, path.join(wsRoot, "escape"));
        await buildSession(
            root,
            "path-case",
            [{ name: "a", type: "float", address: "0x20000000" }],
            [{ ts: 1000, values: ["1"] }]
        );
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        const invalidTargets = [
            "../evil.csv", // 词法 .. 逃逸
            path.join(outsideDir, "evil.csv"), // 工作区外绝对路径
            "escape/evil.csv", // 符号链接逃逸
            "adir" // 目标是已存在的目录
        ];
        await fsp.mkdir(path.join(wsRoot, "adir"));
        for (const outputPath of invalidTargets) {
            const result = await exporter.exportRecording({ recordingId: "path-case", outputPath }).promise;
            assert.strictEqual(result.ok, false, `outputPath must be rejected: ${outputPath}`);
            assert.strictEqual(result.code, "EXPORT_PATH_INVALID", `${outputPath} -> ${result.code}`);
            assert.ok(!(await pathExists(result.outputPath || path.join(wsRoot, "x"))));
        }
        assert.ok(!(await pathExists(path.join(outsideDir, "evil.csv"))), "nothing may be written outside");
        // 工作区内不存在的目录自动创建；相对路径按工作区根解析。
        const created = await exporter.exportRecording({ recordingId: "path-case", outputPath: "newdir/sub/out.csv" })
            .promise;
        assert.strictEqual(created.ok, true, created.message);
        assert.strictEqual(created.outputPath, path.join(wsRoot, "newdir", "sub", "out.csv"));
        assert.ok(await pathExists(created.outputPath));
        // 缺省工作区根 = recordingService.workspacePath（不注入 workspaceRootProvider）。
        const defRoot = makeTempRoot("emberprobe-export-defws-");
        await fsp.mkdir(path.join(defRoot, "workspace-identity"), { recursive: true });
        const defService = makeService(defRoot);
        await defService.start({ names: ["a"] });
        const defId = defService.status().recordingId;
        await defService.ingestSample(["1"], { tMs: 1000 });
        await defService.stop();
        const defExporter = createRecordingExporter({
            recordingService: defService,
            storageRootProvider: () => rawStorageRoot(defRoot)
        });
        const defResult = await defExporter.exportRecording({ recordingId: defId, outputPath: "def.csv" }).promise;
        assert.strictEqual(defResult.ok, true, defResult.message);
        assert.strictEqual(defResult.outputPath, path.join(defRoot, "workspace-identity", "def.csv"));
    }

    // ------------------------------------------------------------ 输入校验
    {
        const root = makeTempRoot("emberprobe-export-input-");
        const wsRoot = makeTempRoot("emberprobe-export-input-ws-");
        await buildSession(
            root,
            "input-case",
            [{ name: "a", type: "float", address: "0x20000000" }],
            [{ ts: 1000, values: ["1"] }]
        );
        const exporter = makeExporter(stub, rawStorageRoot(root), wsRoot);
        const unknownId = await exporter.exportRecording({ recordingId: "missing-id", outputPath: "a.csv" }).promise;
        assert.strictEqual(unknownId.ok, false);
        assert.strictEqual(unknownId.code, "RECORDING_NOT_FOUND");
        const evilId = await exporter.exportRecording({ recordingId: "../evil", outputPath: "a.csv" }).promise;
        assert.strictEqual(evilId.ok, false);
        assert.strictEqual(evilId.code, "RECORDING_NOT_FOUND", "path-like ids must be rejected by the id pattern");
        const unknownVar = await exporter.exportRecording({
            recordingId: "input-case",
            outputPath: "a.csv",
            variables: ["nope"]
        }).promise;
        assert.strictEqual(unknownVar.ok, false);
        assert.strictEqual(unknownVar.code, "EXPORT_VARIABLE_NOT_FOUND");
        const emptyVars = await exporter.exportRecording({
            recordingId: "input-case",
            outputPath: "a.csv",
            variables: []
        }).promise;
        assert.strictEqual(emptyVars.ok, false);
        assert.strictEqual(emptyVars.code, "EXPORT_VARIABLE_NOT_FOUND");
        // 未封存状态（recording/paused-config）拒绝清理；普通只读导出仍可用（含遗留 .part 活动段）。
        const liveSession = await createSession({
            storageRoot: rawStorageRoot(root),
            workspacePath: path.join(root, "ws-identity"),
            recordingId: "live-case",
            fixedVariables: [{ name: "a", type: "float", address: "0x20000000" }]
        });
        await liveSession.appendSampleLine({ timestampMs: 1000, values: ["7"] });
        const livePurge = await exporter.exportRecording({
            recordingId: "live-case",
            outputPath: "live.csv",
            purgeAfterSuccess: true,
            confirmPurge: true
        }).promise;
        assert.strictEqual(livePurge.ok, false);
        assert.strictEqual(livePurge.code, "RECORDING_ACTIVE", "purge must be refused for unfinished sessions");
        const liveExport = await exporter.exportRecording({ recordingId: "live-case", outputPath: "live.csv" }).promise;
        assert.strictEqual(liveExport.ok, true, liveExport.message);
        assert.deepStrictEqual(rowTimes(await readCsvRows(liveExport.outputPath)), [1000]);
        const pausedSession = await buildSession(
            root,
            "paused-case",
            [{ name: "a", type: "float", address: "0x20000000" }],
            [{ ts: 1000, values: ["1"] }],
            "paused-config"
        );
        assert.strictEqual((await readManifest(pausedSession.sessionDir)).status, "paused-config");
        const pausedPurge = await exporter.exportRecording({
            recordingId: "paused-case",
            outputPath: "paused.csv",
            purgeAfterSuccess: true,
            confirmPurge: true
        }).promise;
        assert.strictEqual(pausedPurge.ok, false);
        assert.strictEqual(pausedPurge.code, "RECORDING_ACTIVE");
        await liveSession.close({ status: "interrupted" });
    }

    console.log("all recording-export tests passed");

    for (const dir of tempRoots.splice(0)) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
})().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    }
);

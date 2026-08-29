"use strict";

/**
 * Task 5 UI/桥接测试：录制 UI 纯逻辑（recordingUi）、Agent Bridge 六处理器
 * （recordingAgent，stub 服务）、i18n zh/en 键齐全、消息分支与 webview 资产契约。
 * 不依赖 vscode、OpenOCD 或真实探针。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const recordingUi = require("../src/services/recordingUi");
const { createRecordingAgentHandlers, metadataSnapshot } = require("../src/services/recordingAgent");
const { createRecordingService } = require("../src/services/recordingService");
const liveWatchView = require("../src/liveWatchView");
const zh = require("../src/i18n/zh.js");
const en = require("../src/i18n/en.js");

const root = path.resolve(__dirname, "..");

(async () => {
    // ------------------------------------------------ 录制 UI 纯逻辑
    assert.strictEqual(recordingUi.statusIcon("recording"), "▶", "active sessions use ▶");
    assert.strictEqual(recordingUi.statusIcon("interrupted"), "⏸", "interrupted sessions use ⏸");
    assert.strictEqual(recordingUi.statusIcon("paused-config"), "⏸");
    assert.strictEqual(recordingUi.statusIcon("completed"), "■", "stopped sessions use ■");
    assert.strictEqual(recordingUi.statusIcon("stopped-quota"), "■");
    assert.strictEqual(recordingUi.statusIcon("stopped-error"), "■");
    assert.strictEqual(recordingUi.statusIcon("unknown"), "■");
    assert.strictEqual(recordingUi.isActiveStatus("recording"), true);
    assert.strictEqual(recordingUi.isActiveStatus("completed"), false);

    assert.strictEqual(recordingUi.formatBytes(0), "0B");
    assert.strictEqual(recordingUi.formatBytes(1023), "1023B");
    assert.strictEqual(recordingUi.formatBytes(12.3 * 1024 * 1024), "12.3MiB");
    assert.strictEqual(recordingUi.formatBytes(1.5 * 1024 * 1024 * 1024), "1.5GiB");
    assert.strictEqual(recordingUi.formatCount(0), "0");
    assert.strictEqual(recordingUi.formatCount(123), "123");
    assert.strictEqual(recordingUi.formatCount(45200), "45.2k");
    assert.strictEqual(recordingUi.formatCount(1234567), "1.23M");

    const item = recordingUi.sessionQuickPickItem({
        recordingId: "rec-1",
        status: "recording",
        createdAtMs: new Date(2026, 0, 2, 3, 4, 5).getTime(),
        bytes: 12.3 * 1024 * 1024,
        rows: 45200,
        gaps: 2,
        // 真实契约：recordingService.list() 的条目字段名为 retries（_snapshotFromManifest）
        retries: { attempt: 1, nextAtMs: null },
        quota: { usedBytes: 12.3 * 1024 * 1024, maxMiB: 1024 }
    });
    assert.ok(item.label.startsWith("▶ "), "label starts with the status icon");
    assert.ok(item.label.includes("2026-01-02 03:04:05"), "label shows the session start time");
    assert.ok(item.label.includes("12.3MiB"), "label shows human-readable size");
    assert.ok(item.label.includes("45.2k"), "label shows human-readable row count");
    assert.ok(item.description.includes("gaps:2"), "description includes gap count");
    assert.ok(item.description.includes("retry:1"), "description includes retry attempt");
    assert.ok(item.description.includes("quota"), "description includes quota summary");
    assert.strictEqual(item.recordingId, "rec-1");
    const quietItem = recordingUi.sessionQuickPickItem({
        recordingId: "rec-2",
        status: "completed",
        createdAtMs: 0,
        bytes: 0,
        rows: 0
    });
    assert.strictEqual(quietItem.description, "", "clean sessions have an empty summary");
    assert.ok(!JSON.stringify(item).includes("valueText"), "session items never carry sample bodies");

    // 真实 list() 输出契约（临时存储 + 真实 recordingService）：retries 摘要必须出现在 description
    {
        const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-recording-ui-list-"));
        try {
            const service = createRecordingService({
                context: {
                    globalStorageUri: { fsPath: storageRoot },
                    storageUri: { fsPath: path.join(storageRoot, "workspace-identity") }
                },
                resolveVariables: async (names) =>
                    names.map((name) => ({ name, type: "u32", address: "0x20000000", size: 4 })),
                elfInfo: async () => ({ sha256: "cd".repeat(32), mtimeMs: 111 }),
                hardwareInfo: async () => ({ mcu: "STM32F407VG", probe: "probe-ui-test" }),
                getSamplingInterval: () => 100,
                limits: { maxMiB: 64, globalMaxMiB: 128 }
            });
            const started = await service.start({ names: ["temp"] });
            assert.strictEqual(started.recordingActive, true);
            await service.noteRetryScheduled({ attempt: 3, nextAtMs: 12345 });
            const sessions = await service.list();
            const active = sessions.find((entry) => entry.recordingId === started.recordingId);
            assert.ok(active, "list() must return the active session");
            assert.ok(active.retries && active.retries.attempt === 3, "list() exposes retry state under `retries`");
            const listItem = recordingUi.sessionQuickPickItem(active);
            assert.ok(
                listItem.description.includes("retry:3"),
                "QuickPick description must surface the retry summary from the real list() contract"
            );
            await service.stop();
        } finally {
            fs.rmSync(storageRoot, { recursive: true, force: true });
        }
    }

    // QuickPick 二级菜单的状态过滤：活动会话不出现"导出并删除"、出现"停止"；停止会话相反
    assert.deepStrictEqual(recordingUi.actionsForSession({ status: "recording" }), {
        export: true,
        exportPurge: false,
        stop: true,
        delete: true,
        refresh: true
    });
    assert.deepStrictEqual(recordingUi.actionsForSession({ status: "stopped-quota" }), {
        export: true,
        exportPurge: true,
        stop: false,
        delete: true,
        refresh: true
    });

    // 清理参数：purgeAfterSuccess/confirmPurge 永远同现，且只有用户确认后才为 true
    assert.deepStrictEqual(recordingUi.purgeExportParams(true), { purgeAfterSuccess: true, confirmPurge: true });
    assert.deepStrictEqual(recordingUi.purgeExportParams(false), { purgeAfterSuccess: false, confirmPurge: false });
    assert.deepStrictEqual(recordingUi.purgeExportParams(undefined), { purgeAfterSuccess: false, confirmPurge: false });

    // 时间范围输入：空 = 全部；非法输入拒绝
    assert.deepStrictEqual(recordingUi.parseTimeRangeInput("", ""), { fromMs: null, toMs: null });
    assert.deepStrictEqual(recordingUi.parseTimeRangeInput(" 100 ", "200"), { fromMs: 100, toMs: 200 });
    assert.throws(
        () => recordingUi.parseTimeRangeInput("abc", ""),
        (e) => e.code === "INVALID_RECORDING_RANGE" && /fromMs/.test(e.message)
    );
    assert.throws(
        () => recordingUi.parseTimeRangeInput("200", "100"),
        (e) => e.code === "INVALID_RECORDING_RANGE" && /fromMs/.test(e.message)
    );

    // 并发导出闸：同一会话进行中禁止第二次导出
    const guard = recordingUi.createExportGuard();
    assert.strictEqual(guard.begin("rec-1"), true);
    assert.strictEqual(guard.isActive("rec-1"), true);
    assert.strictEqual(guard.begin("rec-1"), false, "second concurrent export for the same session is rejected");
    assert.strictEqual(guard.begin("rec-2"), true, "a different session may export concurrently");
    guard.end("rec-1");
    assert.strictEqual(guard.begin("rec-1"), true, "after finishing, the session may export again");

    // 桥接层相对输出路径预校验：拒绝绝对路径、盘符、UNC 与 `..`
    assert.strictEqual(recordingUi.validateRelativeOutputPath("exports/a.csv"), "exports/a.csv");
    assert.strictEqual(recordingUi.validateRelativeOutputPath(" a\\b.csv "), "a/b.csv");
    assert.strictEqual(recordingUi.validateRelativeOutputPath("./a.csv"), "a.csv");
    assert.throws(
        () => recordingUi.validateRelativeOutputPath("/abs/x.csv"),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );
    assert.throws(
        () => recordingUi.validateRelativeOutputPath("C:\\x.csv"),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );
    assert.throws(
        () => recordingUi.validateRelativeOutputPath("\\\\server\\share\\x.csv"),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );
    assert.throws(
        () => recordingUi.validateRelativeOutputPath("../x.csv"),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );
    assert.throws(
        () => recordingUi.validateRelativeOutputPath("a/../../x.csv"),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );
    assert.throws(
        () => recordingUi.validateRelativeOutputPath(""),
        (e) => e.code === "EXPORT_PATH_INVALID"
    );

    // ------------------------------------------------ Agent Bridge 六处理器（stub 服务）
    function stubHandlers(exporterOverride, overrides = {}) {
        const calls = [];
        const status = {
            recordingId: "rec-1",
            status: "recording",
            createdAtMs: 1000,
            endedAtMs: null,
            rows: 10,
            bytes: 100,
            gaps: 0,
            retries: null,
            quota: null,
            fixedVariables: [{ name: "Tick", type: "u32", address: "0x20000000", size: 4 }],
            recordingActive: true,
            // 故意放一个非白名单字段，断言被裁剪
            samples: "time,Tick\r\n1,2\r\n"
        };
        const exporter = exporterOverride || {
            exportRecording: (request) => {
                calls.push(["export", request]);
                return {
                    promise: Promise.resolve(
                        request.outputPath === "boom.csv"
                            ? { ok: false, code: "EXPORT_PATH_INVALID", message: "bad path" }
                            : {
                                  ok: true,
                                  rows: 5,
                                  bytes: 60,
                                  outputPath: "/ws/" + request.outputPath,
                                  purged: request.purgeAfterSuccess === true,
                                  csv: "time,Tick\r\n"
                              }
                    ),
                    cancel: () => calls.push(["cancel"])
                };
            }
        };
        const handlers = createRecordingAgentHandlers({
            startRecording: async (params) => {
                calls.push(["start", params]);
                return { ...status };
            },
            stopRecording: async () => {
                calls.push(["stop"]);
                return { ...status, status: "completed", recordingActive: false };
            },
            statusSync: () => {
                calls.push(["status"]);
                return { ...status };
            },
            list: async () => {
                calls.push(["list"]);
                return [
                    { ...status },
                    { ...status, recordingId: "rec-0", status: "completed", recordingActive: false }
                ];
            },
            deleteRecording: async (recordingId, opts) => {
                calls.push(["delete", recordingId, opts]);
                if (!opts || opts.confirmed !== true) {
                    throw Object.assign(new Error("deletion requires explicit confirmation"), {
                        code: "CONFIRMATION_REQUIRED"
                    });
                }
                return { deleted: recordingId };
            },
            exporter,
            ...overrides
        });
        return { handlers, calls, status };
    }

    {
        const { handlers, calls } = stubHandlers();
        // recording.start：变量名列表必填，控制参数透传，返回白名单元数据
        const started = await handlers["recording.start"]({ names: ["Tick", " sensor.x "], intervalMs: 100 });
        assert.deepStrictEqual(calls[0], ["start", { names: ["Tick", "sensor.x"], intervalMs: 100 }]);
        assert.strictEqual(started.recordingId, "rec-1");
        assert.strictEqual(started.status, "recording");
        assert.ok(Array.isArray(started.fixedVariables) && started.fixedVariables[0].name === "Tick");
        assert.strictEqual(started.samples, undefined, "handler output must be metadata only (whitelisted fields)");
        assert.ok(
            !JSON.stringify(started).includes("time,Tick"),
            "no sample/CSV text may leak through recording.start"
        );
        await assert.rejects(
            () => handlers["recording.start"]({ names: [] }),
            (e) => e.code === "NO_VARIABLES",
            "recording.start requires a variable name list"
        );
        await assert.rejects(
            () => handlers["recording.start"]({ names: ["Tick"], intervalMs: -5 }),
            (e) => e.code === "INVALID_RECORDING_RANGE"
        );

        // recording.status / recording.list：元数据快照
        const snap = await handlers["recording.status"]({});
        assert.deepStrictEqual(
            calls.some((c) => c[0] === "status"),
            true
        );
        assert.strictEqual(snap.rows, 10);
        assert.strictEqual(snap.samples, undefined);
        const listed = await handlers["recording.list"]({});
        assert.strictEqual(listed.recordings.length, 2);
        assert.strictEqual(listed.recordings[1].recordingId, "rec-0");
        assert.ok(!JSON.stringify(listed).includes("time,Tick"), "recording.list must not return sample bodies");
        assert.ok(!("csv" in listed), "recording.list must not return CSV content");

        // recording.stop：幂等透传
        const stopped = await handlers["recording.stop"]({});
        assert.ok(calls.some((c) => c[0] === "stop"));
        assert.strictEqual(stopped.status, "completed");

        // recording.delete：缺 confirmed → CONFIRMATION_REQUIRED（与 recordingService 一致）
        await assert.rejects(
            () => handlers["recording.delete"]({ recordingId: "rec-1" }),
            (e) => e.code === "CONFIRMATION_REQUIRED"
        );
        const deleted = await handlers["recording.delete"]({ recordingId: "rec-1", confirmed: true });
        assert.deepStrictEqual(deleted, { deleted: "rec-1" });
        assert.deepStrictEqual(calls.filter((c) => c[0] === "delete").pop(), ["delete", "rec-1", { confirmed: true }]);
    }

    {
        // recording.export：控制参数透传 + 元数据返回；CSV 内容经白名单裁剪
        const { handlers, calls } = stubHandlers();
        const exported = await handlers["recording.export"]({
            recordingId: "rec-1",
            variables: ["Tick"],
            fromMs: 10,
            toMs: 20,
            outputPath: "exports/a.csv"
        });
        assert.deepStrictEqual(calls[0][0], "export");
        const request = calls[0][1];
        assert.strictEqual(request.recordingId, "rec-1");
        assert.deepStrictEqual(request.variables, ["Tick"]);
        assert.strictEqual(request.fromMs, 10);
        assert.strictEqual(request.toMs, 20);
        assert.strictEqual(request.outputPath, "exports/a.csv");
        assert.strictEqual(request.purgeAfterSuccess, false);
        assert.strictEqual(request.confirmPurge, false);
        assert.deepStrictEqual(
            Object.keys(exported).sort(),
            ["bytes", "ok", "outputPath", "purged", "rows"],
            "export result is whitelisted metadata"
        );
        assert.strictEqual(exported.ok, true);
        assert.ok(!JSON.stringify(exported).includes("time,Tick"), "export result must never contain CSV body");

        // --purge 映射：purgeAfterSuccess 与 confirmPurge 同现
        await handlers["recording.export"]({
            recordingId: "rec-1",
            outputPath: "exports/b.csv",
            purgeAfterSuccess: true,
            confirmPurge: true
        });
        assert.strictEqual(calls[1][1].purgeAfterSuccess, true);
        assert.strictEqual(calls[1][1].confirmPurge, true);

        // 导出失败：错误码向上透传
        await assert.rejects(
            () => handlers["recording.export"]({ recordingId: "rec-1", outputPath: "boom.csv" }),
            (e) => e.code === "EXPORT_PATH_INVALID"
        );
        // 绝对路径与 .. 在桥接层拒绝（exporter 不被触达）
        await assert.rejects(
            () => handlers["recording.export"]({ recordingId: "rec-1", outputPath: "/abs/x.csv" }),
            (e) => e.code === "EXPORT_PATH_INVALID"
        );
        await assert.rejects(
            () => handlers["recording.export"]({ recordingId: "rec-1", outputPath: "../x.csv" }),
            (e) => e.code === "EXPORT_PATH_INVALID"
        );
        assert.strictEqual(
            calls.filter((c) => c[0] === "export").length,
            3,
            "rejected paths must not reach the exporter (boom.csv is an exporter-level failure)"
        );
    }

    {
        // 并发导出：同一会话进行中的第二次导出被拒绝（EXPORT_IN_PROGRESS），结束后放行
        let releaseFirst;
        const firstPromise = new Promise((resolve) => {
            releaseFirst = () => resolve({ ok: true, rows: 1, bytes: 2, outputPath: "/ws/slow.csv", purged: false });
        });
        const exporter = {
            exportRecording: (request) => ({
                promise:
                    request.outputPath === "slow.csv"
                        ? firstPromise
                        : Promise.resolve({ ok: true, rows: 1, bytes: 2, outputPath: "/ws/x", purged: false }),
                cancel: () => {}
            })
        };
        const { handlers } = stubHandlers(exporter);
        const first = handlers["recording.export"]({ recordingId: "rec-1", outputPath: "slow.csv" });
        await assert.rejects(
            () => handlers["recording.export"]({ recordingId: "rec-1", outputPath: "other.csv" }),
            (e) => e.code === recordingUi.EXPORT_IN_PROGRESS,
            "a second concurrent export for the same session must be rejected"
        );
        releaseFirst();
        const firstResult = await first;
        assert.strictEqual(firstResult.ok, true);
        const after = await handlers["recording.export"]({ recordingId: "rec-1", outputPath: "after.csv" });
        assert.strictEqual(after.ok, true, "after the first export finishes, a new export is allowed");
    }

    // ------------------------------------------------ i18n：zh/en 键集合一致
    const zhKeys = Object.keys(zh).sort();
    const enKeys = Object.keys(en).sort();
    assert.deepStrictEqual(zhKeys, enKeys, "zh and en i18n tables must define the same key sets");
    for (const key of [
        "lw.recStart",
        "lw.recStop",
        "lw.recExport",
        "lw.recManage",
        "lw.recRowsUnit",
        "lw.recPaused",
        "lw.recGap",
        "lw.recRetry",
        "recording.ui.stopConfirm",
        "recording.ui.stop",
        "recording.ui.notActive",
        "recording.ui.manageTitle",
        "recording.ui.actionTitle",
        "recording.ui.actionExport",
        "recording.ui.actionExportPurge",
        "recording.ui.actionStop",
        "recording.ui.actionDelete",
        "recording.ui.actionRefresh",
        "recording.ui.purgeWarning",
        "recording.ui.purgeConfirm",
        "recording.ui.deleteWarning",
        "recording.ui.deleteConfirm",
        "recording.ui.deleteActive",
        "recording.ui.deleted",
        "recording.ui.noSessions",
        "recording.ui.exportScopeTitle",
        "recording.ui.exportFromPrompt",
        "recording.ui.exportToPrompt",
        "recording.ui.invalidRange",
        "recording.ui.exporting",
        "recording.ui.exportSave",
        "recording.ui.exportDone",
        "recording.ui.exportPurged",
        "recording.ui.exportCancelled",
        "recording.ui.exportFailed",
        "recording.ui.exportBusy",
        "recording.ui.actionFailed"
    ]) {
        assert.ok(typeof zh[key] === "string" && zh[key].length > 0, `zh must define ${key}`);
        assert.ok(typeof en[key] === "string" && en[key].length > 0, `en must define ${key}`);
    }

    // ------------------------------------------------ 扩展侧消息分支契约（源码检查）
    const providerSource = fs.readFileSync(path.join(root, "src", "mainViewProvider.js"), "utf8");
    for (const type of ["recordingStart", "recordingStop", "recordingExport", "recordingManage"]) {
        assert.ok(providerSource.includes(`case '${type}'`), `live panel must route ${type} messages`);
    }
    const agentSource = fs.readFileSync(path.join(root, "src", "services", "recordingAgent.js"), "utf8");
    assert.ok(
        providerSource.includes("...this._recordingAgentHandlers"),
        "Agent Bridge must register the recording handlers from the shared factory"
    );
    for (const method of [
        "recording.start",
        "recording.status",
        "recording.list",
        "recording.stop",
        "recording.export",
        "recording.delete"
    ]) {
        assert.ok(agentSource.includes(`"${method}":`), `Agent Bridge must expose ${method}`);
    }
    // Task 4 预留注入缝：导出器必须注入真实用户工作区根，而不是扩展存储目录
    assert.ok(
        providerSource.includes("workspaceRootProvider: () => this._recordingWorkspaceRoot()"),
        "exporter must receive the real workspace root via workspaceRootProvider"
    );
    assert.ok(
        providerSource.includes("vscode.workspace.workspaceFolders?.[0]"),
        "workspace root must come from the user's workspace folder"
    );
    assert.ok(
        providerSource.includes(
            "storageRootProvider: () => path.join(this._context.globalStorageUri.fsPath, 'recordings')"
        ),
        "storageRootProvider must match the recording service storage root"
    );
    // 在线导出：purgeAfterSuccess:false, confirmPurge:false；进度可取消
    assert.ok(
        providerSource.includes("purgeAfterSuccess: false, confirmPurge: false") ||
            providerSource.includes("purge: false"),
        "online export must never purge"
    );
    assert.ok(
        providerSource.includes("token.onCancellationRequested(() => handle.cancel())"),
        "export progress must be cancellable"
    );
    // 清理提示先于 purge 参数传递（计划要求界面预先明确提示未选择的数据也将丢弃）
    const purgeWarningIndex = providerSource.indexOf("recording.ui.purgeWarning");
    const purgeFlagIndex = providerSource.indexOf("purge = true");
    assert.ok(
        purgeWarningIndex >= 0 && purgeFlagIndex > purgeWarningIndex,
        "the purge warning must be shown before purgeAfterSuccess/confirmPurge are set"
    );
    assert.ok(
        providerSource.includes("_recordingService.delete(session.recordingId, { confirmed: true })"),
        "deletion from the management UI must pass confirmed:true after the dialog"
    );
    assert.ok(
        providerSource.includes("_recordingExportGuard.begin(recordingId)"),
        "UI exports must take the shared concurrent-export guard"
    );
    // 所有不经 _postConsumerStatuses 的 liveStatus 广播也必须携带录制快照：
    // 否则无 recording 字段的消息到达波形面板时，录制工具栏会被（正确地）保留而非刷新，
    // 面板打开（ready→_syncGraphTarget）期间的工具栏状态将一直是模板默认值。
    const methodStart = (signature) => providerSource.indexOf("\n" + signature);
    const syncGraphBlock = providerSource.slice(
        methodStart("    _syncGraphTarget(entry) {"),
        methodStart("    _syncSidebarTarget(post) {")
    );
    const syncSidebarBlock = providerSource.slice(
        methodStart("    _syncSidebarTarget(post) {"),
        methodStart("    _activeReadPlan() {")
    );
    const postConsumerBlock = providerSource.slice(
        methodStart("    _postConsumerStatuses(payload, error = false) {"),
        methodStart("    _scalarWatchList(key) {")
    );
    assert.ok(syncGraphBlock && syncSidebarBlock && postConsumerBlock, "contract slices must be non-empty");
    for (const [name, block] of [
        ["_syncGraphTarget", syncGraphBlock],
        ["_syncSidebarTarget", syncSidebarBlock],
        ["_postConsumerStatuses", postConsumerBlock]
    ]) {
        assert.ok(
            block.includes("recording: this._recordingStatusSnapshot()"),
            `${name} broadcast must attach the recording snapshot`
        );
    }
    assert.ok(
        providerSource.includes("agentOwned: running, recording: this._recordingStatusSnapshot()"),
        "_postAgentSampling broadcasts must attach the recording snapshot (agent sampling does not change recording state)"
    );

    // ------------------------------------------------ 波形 UI（模板 + renderer）契约
    const panelZh = liveWatchView.getLiveWatchContent({ maxSamples: 100, intervalMs: 20 }, "zh");
    for (const id of ['id="recToggle"', 'id="recExport"', 'id="recManage"', 'id="recBadge"']) {
        assert.ok(panelZh.includes(id), `live watch toolbar must contain ${id}`);
    }
    assert.ok(panelZh.includes(">开始录制</button>"), "record toggle starts in the 开始录制 state");
    assert.ok(panelZh.includes('id="recExport" class="ghost" disabled'), "live export is disabled while not recording");
    const panelEn = liveWatchView.getLiveWatchContent({ maxSamples: 100, intervalMs: 20 }, "en");
    assert.ok(panelEn.includes(">Start Recording</button>"), "English toolbar translates the record button");

    const rendererSource = fs.readFileSync(path.join(root, "src", "webview", "liveWatch", "renderer.js"), "utf8");
    for (const type of ["recordingStart", "recordingStop", "recordingExport", "recordingManage"]) {
        assert.ok(rendererSource.includes(`type:'${type}'`), `renderer must post ${type}`);
    }
    assert.ok(
        rendererSource.includes("m.type==='liveStatus'&&m.recording!==undefined)updateRecording(m.recording)"),
        "renderer must only update the recording toolbar when liveStatus explicitly carries a recording field"
    );
    assert.ok(
        !rendererSource.includes("'liveStatus')updateRecording("),
        "unconditional liveStatus recording updates would reset the toolbar on broadcasts without the field"
    );
    assert.ok(
        rendererSource.includes("recActive?t('lw.recStop'):t('lw.recStart')"),
        "toggle label is driven by the recording state"
    );
    assert.ok(rendererSource.includes("ex.disabled=!recActive"), "live export button is enabled only while recording");
    assert.ok(!/setInterval\([^)]*rec/i.test(rendererSource), "recording UI must not poll; it is broadcast-driven");
    assert.ok(
        rendererSource.includes("type:'recordingStart',names:watch.map"),
        "recording start passes the chart watch list"
    );

    console.log("Recording UI tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

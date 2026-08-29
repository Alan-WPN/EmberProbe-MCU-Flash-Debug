"use strict";

/**
 * Task 5 技能测试：mcu-recording 技能脚本（record.js 五子命令的参数解析与校验）、
 * manifest.json 注册与 required 文件、SKILL.md frontmatter，以及经真实 AgentBridge
 * 的端到端调用（stub 领域服务，断言参数透传与"只返回元数据、绝不返回 CSV 正文"）。
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { AgentBridge } = require("../src/agentBridge");
const skillInstaller = require("../src/skillInstaller");
const record = require("../skills/mcu-recording/scripts/record");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const recordScript = path.join(root, "skills", "mcu-recording", "scripts", "record.js");

(async () => {
    // ------------------------------------------------ 参数解析
    assert.throws(() => record.args([]), /Choose one command/);
    assert.throws(() => record.args(["bogus"]), /Unknown command/);
    assert.throws(() => record.args(["status", "start"]), /Unexpected argument/);
    assert.throws(() => record.args(["status", "--nope"]), /Unknown argument/);
    assert.throws(() => record.args(["start", "--variables"]), /Missing value for --variables/);
    const parsed = record.args(["export", "--id", "rec-1", "--out", "exports/a.csv", "--purge"]);
    assert.strictEqual(parsed.command, "export");
    assert.deepStrictEqual(parsed.flags, { id: "rec-1", out: "exports/a.csv", purge: true });
    assert.deepStrictEqual(record.SUBCOMMANDS, new Set(["start", "status", "stop", "export", "delete"]));

    // ------------------------------------------------ 子命令 → 桥接方法映射
    const start = record.request(record.args(["start", "--variables", "Tick, sensor.x", "--interval-ms", "100"]));
    assert.strictEqual(start.method, "recording.start");
    assert.deepStrictEqual(start.params.names, ["Tick", "sensor.x"]);
    assert.strictEqual(start.params.intervalMs, 100);
    assert.throws(() => record.request(record.args(["start"])), /--variables/, "start requires a variable name list");

    assert.strictEqual(record.request(record.args(["status"])).method, "recording.status");
    assert.strictEqual(record.request(record.args(["stop"])).method, "recording.stop");

    // export：--out 必须是工作区内相对路径；--purge 需要 --confirm-purge
    const plainExport = record.request(record.args(["export", "--id", "rec-1", "--out", "exports/a.csv"]));
    assert.strictEqual(plainExport.method, "recording.export");
    assert.strictEqual(plainExport.params.recordingId, "rec-1");
    assert.strictEqual(plainExport.params.outputPath, "exports/a.csv");
    assert.strictEqual(plainExport.params.purgeAfterSuccess, false);
    assert.strictEqual(plainExport.params.confirmPurge, false);
    assert.strictEqual(
        plainExport.timeoutMs,
        1800000,
        "exports stream large recordings and need a long bridge timeout"
    );
    const subsetExport = record.request(
        record.args([
            "export",
            "--id",
            "rec-1",
            "--variables",
            "Tick,A.c",
            "--from-ms",
            "10",
            "--to-ms",
            "20",
            "--out",
            "a.csv"
        ])
    );
    assert.deepStrictEqual(subsetExport.params.variables, ["Tick", "A.c"]);
    assert.strictEqual(subsetExport.params.fromMs, 10);
    assert.strictEqual(subsetExport.params.toMs, 20);
    assert.throws(() => record.request(record.args(["export", "--out", "a.csv"])), /--id/, "export requires --id");
    assert.throws(() => record.request(record.args(["export", "--id", "rec-1"])), /--out/, "export requires --out");
    try {
        record.request(record.args(["export", "--id", "rec-1", "--out", "a.csv", "--purge"]));
        assert.fail("--purge without --confirm-purge must be rejected");
    } catch (error) {
        assert.strictEqual(error.code, "CONFIRMATION_REQUIRED");
        assert.match(error.message, /--confirm-purge/);
    }
    const purged = record.request(
        record.args(["export", "--id", "rec-1", "--out", "a.csv", "--purge", "--confirm-purge"])
    );
    assert.strictEqual(purged.params.purgeAfterSuccess, true);
    assert.strictEqual(purged.params.confirmPurge, true);

    // --out 路径校验：绝对路径（POSIX/盘符/UNC）与 `..` 全部拒绝
    assert.strictEqual(record.validateRelativeOut("exports/a.csv"), "exports/a.csv");
    assert.strictEqual(record.validateRelativeOut("./a.csv"), "a.csv");
    assert.strictEqual(record.validateRelativeOut("a\\b.csv"), "a/b.csv");
    assert.throws(() => record.validateRelativeOut("/abs/a.csv"), /workspace-relative/);
    assert.throws(() => record.validateRelativeOut("C:\\a.csv"), /workspace-relative/);
    assert.throws(() => record.validateRelativeOut("\\\\server\\share\\a.csv"), /workspace-relative/);
    assert.throws(() => record.validateRelativeOut("../a.csv"), /"\.\."/);
    assert.throws(() => record.validateRelativeOut("a/../../a.csv"), /"\.\."/);
    assert.throws(() => record.validateRelativeOut(""), /--out/);
    assert.throws(
        () => record.request(record.args(["export", "--id", "rec-1", "--out", "/abs/a.csv"])),
        /workspace-relative/,
        "absolute --out is rejected on the script side before any bridge call"
    );

    // delete：缺 --confirm 时 confirmed=false，桥接层 recordingService 报 CONFIRMATION_REQUIRED
    assert.throws(() => record.request(record.args(["delete"])), /--id/);
    assert.deepStrictEqual(record.request(record.args(["delete", "--id", "rec-1"])).params, {
        recordingId: "rec-1",
        confirmed: false
    });
    assert.deepStrictEqual(record.request(record.args(["delete", "--id", "rec-1", "--confirm"])).params, {
        recordingId: "rec-1",
        confirmed: true
    });

    // ------------------------------------------------ manifest 注册与 required 文件
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "skills", "manifest.json"), "utf8"));
    const entry = manifest.skills.find((skill) => skill.name === "mcu-recording");
    assert.ok(entry, "manifest must register the mcu-recording skill");
    assert.ok(
        typeof entry.version === "string" && /^\d+\.\d+\.\d+$/.test(entry.version),
        "skill entry must carry a version"
    );
    assert.strictEqual(entry.runtime, true);
    assert.deepStrictEqual(entry.required, ["SKILL.md", "scripts/record.js", "agents/openai.yaml"]);
    for (const relative of entry.required) {
        assert.ok(fs.statSync(path.join(root, "skills", "mcu-recording", relative)).size > 0, `${relative} must exist`);
    }
    // 安装器按 manifest 逐文件校验：新技能必须能通过既有校验（readManifest + inspectSkill）
    const manifestViaInstaller = await skillInstaller.readManifest({ extensionPath: root });
    assert.ok(manifestViaInstaller.skills.some((skill) => skill.name === "mcu-recording"));

    // SKILL.md frontmatter：name/description 风格与 mcu-live-watch 一致
    const skillMd = fs.readFileSync(path.join(root, "skills", "mcu-recording", "SKILL.md"), "utf8");
    assert.ok(skillMd.startsWith("---\n"), "SKILL.md must start with a frontmatter block");
    const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---", 4));
    assert.ok(/^name: mcu-recording$/m.test(frontmatter), "frontmatter must name the skill");
    assert.ok(/^description: .{40,}/m.test(frontmatter), "frontmatter must carry a meaningful description");
    for (const command of ["start", "status", "stop", "export", "delete"]) {
        assert.ok(
            skillMd.includes(`\`${command}\``) || skillMd.includes(` ${command} `),
            `SKILL.md must document ${command}`
        );
    }
    assert.ok(
        skillMd.includes("--purge") && skillMd.includes("--confirm-purge"),
        "SKILL.md must explain the purge confirmation flags"
    );
    assert.ok(
        /report/i.test(skillMd) && /relative path/i.test(skillMd),
        "SKILL.md must require reporting the export path first"
    );
    assert.ok(/permanently discarded|永久丢弃/.test(skillMd), "SKILL.md must restate the purge data-loss warning");

    // ------------------------------------------------ 端到端：真实 AgentBridge + 真实桥接处理器 + stub 领域服务
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-recording-skill-"));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-recording-skill-storage-"));
    const calls = [];
    const session = {
        recordingId: "rec-1",
        status: "recording",
        rows: 7,
        bytes: 99,
        fixedVariables: [{ name: "Tick", type: "u32", address: "0x20000000", size: 4 }],
        // 故意携带非白名单字段：真实桥接处理器必须裁剪，输出绝不包含样本正文
        samples: "time,Tick\r\nSHOULD_NOT_LEAK\r\n"
    };
    const recordingAgent = require("../src/services/recordingAgent");
    const handlers = recordingAgent.createRecordingAgentHandlers({
        startRecording: async (params) => {
            calls.push({ method: "recording.start", params });
            return { ...session };
        },
        stopRecording: async () => {
            calls.push({ method: "recording.stop", params: {} });
            return { ...session, status: "completed" };
        },
        statusSync: () => {
            calls.push({ method: "recording.status", params: {} });
            return { ...session };
        },
        list: async () => {
            calls.push({ method: "recording.list", params: {} });
            return [{ ...session }, { ...session, recordingId: "rec-0", status: "completed" }];
        },
        deleteRecording: async (recordingId, opts) => {
            calls.push({ method: "recording.delete", params: { recordingId, ...opts } });
            if (!opts || opts.confirmed !== true) {
                throw Object.assign(new Error("deletion requires explicit confirmation"), {
                    code: "CONFIRMATION_REQUIRED"
                });
            }
            return { deleted: recordingId };
        },
        exporter: {
            exportRecording: (request) => {
                calls.push({ method: "recording.export", params: request });
                return {
                    // 领域层返回值故意携带 CSV 字段：桥接处理器必须把它裁剪掉
                    promise: Promise.resolve({
                        ok: true,
                        rows: 3,
                        bytes: 42,
                        outputPath: `/ws/${request.outputPath}`,
                        purged: request.purgeAfterSuccess === true,
                        csv: "time,Tick\r\nSHOULD_NOT_LEAK\r\n"
                    }),
                    cancel: () => {}
                };
            }
        }
    });
    const bridge = new AgentBridge(workspace, async (method, params) => handlers[method](params || {}), storage);
    // 运行技能脚本并断言：stdout 只含元数据 JSON，绝不包含样本正文/CSV 内容
    const runRecord = async (scriptArgs) => {
        const result = await execFileAsync(process.execPath, [recordScript, "--workspace", workspace, ...scriptArgs]);
        assert.ok(
            !result.stdout.includes("SHOULD_NOT_LEAK") && !result.stdout.includes("time,Tick"),
            "skill output must never carry sample bodies or CSV content"
        );
        return result;
    };
    try {
        await bridge.start();

        const status = JSON.parse((await runRecord(["status"])).stdout);
        assert.strictEqual(status.recordingId, "rec-1");
        assert.strictEqual(status.samples, undefined, "status output must be whitelisted metadata");
        assert.deepStrictEqual(calls[calls.length - 1], { method: "recording.status", params: {} });

        const started = JSON.parse(
            (await runRecord(["start", "--variables", "Tick,sensor.x", "--interval-ms", "100"])).stdout
        );
        assert.strictEqual(started.recordingId, "rec-1");
        assert.deepStrictEqual(calls[calls.length - 1], {
            method: "recording.start",
            params: { names: ["Tick", "sensor.x"], intervalMs: 100 }
        });

        const stopped = JSON.parse((await runRecord(["stop"])).stdout);
        assert.strictEqual(stopped.status, "completed");
        assert.strictEqual(calls[calls.length - 1].method, "recording.stop");

        const exported = JSON.parse((await runRecord(["export", "--id", "rec-1", "--out", "exports/a.csv"])).stdout);
        assert.strictEqual(exported.ok, true);
        assert.strictEqual(exported.rows, 3);
        assert.strictEqual(exported.outputPath, "/ws/exports/a.csv");
        assert.strictEqual(exported.purged, false);
        assert.strictEqual(exported.csv, undefined, "export output must be metadata only");
        const exportCall = calls[calls.length - 1];
        assert.strictEqual(exportCall.method, "recording.export");
        assert.strictEqual(exportCall.params.recordingId, "rec-1");
        assert.strictEqual(exportCall.params.outputPath, "exports/a.csv");
        assert.strictEqual(exportCall.params.purgeAfterSuccess, false);
        assert.strictEqual(exportCall.params.confirmPurge, false);

        const purgedExport = JSON.parse(
            (await runRecord(["export", "--id", "rec-1", "--out", "exports/b.csv", "--purge", "--confirm-purge"]))
                .stdout
        );
        assert.strictEqual(purgedExport.purged, true);
        const purgedCall = calls[calls.length - 1];
        assert.strictEqual(purgedCall.params.purgeAfterSuccess, true);
        assert.strictEqual(purgedCall.params.confirmPurge, true);

        // delete 缺 --confirm：桥接层报 CONFIRMATION_REQUIRED，脚本输出诊断
        let diagnostic;
        try {
            await runRecord(["delete", "--id", "rec-1"]);
            assert.fail("delete without --confirm must fail");
        } catch (error) {
            assert.ok(!error.stdout.includes("SHOULD_NOT_LEAK"));
            diagnostic = JSON.parse(error.stderr);
        }
        assert.strictEqual(diagnostic.error.code, "CONFIRMATION_REQUIRED");
        const confirmedDelete = JSON.parse((await runRecord(["delete", "--id", "rec-1", "--confirm"])).stdout);
        assert.deepStrictEqual(confirmedDelete, { deleted: "rec-1" });

        // --out 绝对路径：脚本侧拒绝，桥接不被调用
        const callCountBefore = calls.length;
        let pathDiagnostic;
        try {
            await execFileAsync(process.execPath, [
                recordScript,
                "--workspace",
                workspace,
                "export",
                "--id",
                "rec-1",
                "--out",
                "/abs/a.csv"
            ]);
            assert.fail("absolute --out must fail");
        } catch (error) {
            assert.strictEqual(error.code, 1);
            pathDiagnostic = JSON.parse(error.stderr);
        }
        assert.strictEqual(pathDiagnostic.error.code, "EXPORT_PATH_INVALID");
        assert.strictEqual(calls.length, callCountBefore, "script-side path rejection must not reach the bridge");

        // 全部桥接调用都以 recording. 开头（五子命令 → 六方法映射）
        for (const { method } of calls) assert.ok(method.startsWith("recording."));
    } finally {
        await bridge.stop();
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(storage, { recursive: true, force: true });
    }

    console.log("Recording skills tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

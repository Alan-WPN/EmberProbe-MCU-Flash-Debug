"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
    inspectSkill,
    installSkill,
    uninstallSkill,
    inspectSkills,
    isUnmodifiedLegacySkill,
    removeUnmodifiedLegacySkills
} = require("../src/skillInstaller");

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-skills-"));
    const sourceRoot = path.join(root, "source");
    const targetRoot = path.join(root, "target");
    const entry = { name: "demo", version: "1.0.0", required: ["SKILL.md", "scripts/run.js"] };
    try {
        fs.mkdirSync(path.join(sourceRoot, "demo", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, "demo", "SKILL.md"), "demo");
        fs.writeFileSync(path.join(sourceRoot, "demo", "scripts", "run.js"), "demo");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "notInstalled");

        fs.mkdirSync(path.join(targetRoot, "demo"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, "demo", "SKILL.md"), "demo");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "partial");

        fs.mkdirSync(path.join(targetRoot, "demo", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(targetRoot, "demo", "scripts", "run.js"), "demo");
        fs.writeFileSync(path.join(targetRoot, "demo", ".emberprobe-skill.json"), JSON.stringify({ version: "0.9.0" }));
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "outdated");

        fs.writeFileSync(path.join(targetRoot, "demo", ".emberprobe-skill.json"), JSON.stringify({ version: "1.0.0" }));
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "installed");

        fs.writeFileSync(path.join(targetRoot, "demo", "scripts", "run.js"), "changed");
        assert.strictEqual((await inspectSkill(sourceRoot, targetRoot, entry)).state, "modified");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    // 重命名迁移只删除元数据、版本、文件集和指纹都与已发布版本一致的旧 Skill。
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-legacy-"));
    const legacyEntry = {
        name: "old-skill",
        version: "1.0.0",
        files: {
            "SKILL.md": crypto.createHash("sha256").update("legacy skill").digest("hex"),
            "scripts/run.js": crypto.createHash("sha256").update("legacy script").digest("hex")
        }
    };
    try {
        const legacySkill = path.join(legacyRoot, legacyEntry.name);
        fs.mkdirSync(path.join(legacySkill, "scripts"), { recursive: true });
        fs.writeFileSync(path.join(legacySkill, "SKILL.md"), "legacy skill");
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "legacy script");
        fs.writeFileSync(
            path.join(legacySkill, ".emberprobe-skill.json"),
            JSON.stringify({ name: legacyEntry.name, version: legacyEntry.version })
        );
        assert.strictEqual(await isUnmodifiedLegacySkill(legacyRoot, legacyEntry), true);
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "user modified");
        assert.strictEqual(await isUnmodifiedLegacySkill(legacyRoot, legacyEntry), false);
        assert.deepStrictEqual(await removeUnmodifiedLegacySkills({ legacySkills: [legacyEntry] }, legacyRoot), []);
        assert.ok(fs.existsSync(legacySkill), "modified legacy skill must be preserved");
        fs.writeFileSync(path.join(legacySkill, "scripts", "run.js"), "legacy script");
        assert.deepStrictEqual(await removeUnmodifiedLegacySkills({ legacySkills: [legacyEntry] }, legacyRoot), [
            legacyEntry.name
        ]);
        assert.ok(!fs.existsSync(legacySkill), "unmodified legacy skill should be removed during migration");
    } finally {
        fs.rmSync(legacyRoot, { recursive: true, force: true });
    }

    // 双范围安装/卸载:全局目录经 os.homedir() 解析,测试内重定向到临时目录保证确定性
    const realHomedir = os.homedir;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-home-"));
    os.homedir = () => home;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-install-"));
    const vscode = {
        workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] },
        window: { showInformationMessage() {} }
    };
    const noWorkspaceVscode = { workspace: { workspaceFolders: [] }, window: { showInformationMessage() {} } };
    const context = { extensionPath: path.resolve(__dirname, "..") };
    try {
        const installed = await installSkill(vscode, context, "en");
        assert.strictEqual(installed.state, "installed");
        assert.strictEqual(installed.installed, 8);
        assert.strictEqual(installed.scopes.workspace.state, "installed");
        assert.strictEqual(installed.scopes.global.state, "notInstalled");
        fs.unlinkSync(path.join(workspace, ".agents", "skills", "mcu-chip-info", "scripts", "read-chip.js"));
        const partial = await inspectSkills(vscode, context);
        assert.strictEqual(partial.state, "partial");
        assert.strictEqual(partial.skills.find((item) => item.name === "mcu-chip-info").state, "partial");

        // 全局安装不要求工作区,与项目范围相互独立
        const globalInstall = await installSkill(noWorkspaceVscode, context, "en", "global");
        assert.strictEqual(globalInstall.state, "installed");
        assert.strictEqual(globalInstall.scopes.global.state, "installed");
        assert.strictEqual(globalInstall.scopes.workspace, null);
        assert.ok(fs.existsSync(path.join(home, ".agents", "skills", "mcu-chip-info", "SKILL.md")));
        const workspaceStillWins = await inspectSkills(vscode, context);
        assert.strictEqual(
            workspaceStillWins.state,
            "partial",
            "a clean global copy must not hide the workspace copy that agents resolve first"
        );

        const staleExtra = path.join(workspace, ".agents", "skills", "mcu-flash", "scripts", "stale.js");
        fs.writeFileSync(staleExtra, "stale");
        await installSkill(vscode, context, "en", "workspace");
        assert.ok(
            !fs.existsSync(staleExtra),
            "reinstall must replace EmberProbe-owned skill directories instead of merging extras"
        );

        // 项目范围卸载:只移除 manifest 内 skill 与共享运行时,保留用户自建 skill
        fs.mkdirSync(path.join(workspace, ".agents", "skills", "user-skill"), { recursive: true });
        fs.mkdirSync(path.join(workspace, ".emberprobe"), { recursive: true });
        fs.writeFileSync(path.join(workspace, ".emberprobe", "agent-bridge.json"), "{}");
        const uninstalled = await uninstallSkill(vscode, context, "en", "workspace");
        assert.strictEqual(uninstalled.scopes.workspace.state, "notInstalled");
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "_emberprobe")));
        assert.ok(!fs.existsSync(path.join(workspace, ".agents", "skills", "mcu-chip-info")));
        assert.ok(
            fs.existsSync(path.join(workspace, ".agents", "skills", "user-skill")),
            "user-created skills must be preserved"
        );
        assert.ok(
            !fs.existsSync(path.join(workspace, ".emberprobe")),
            "workspace uninstall must remove the Bridge pointer directory"
        );

        // 全局卸载后目录已空,应整体移除 skills 目录
        const globalUninstall = await uninstallSkill(vscode, context, "en", "global");
        assert.strictEqual(globalUninstall.scopes.global.state, "notInstalled");
        assert.strictEqual(globalUninstall.state, "notInstalled");
        assert.ok(!fs.existsSync(path.join(home, ".agents", "skills")));
    } finally {
        os.homedir = realHomedir;
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
    console.log("Skill installer tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

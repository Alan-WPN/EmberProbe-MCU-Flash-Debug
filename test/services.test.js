"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ConfigurationStore, assertAgentSettable } = require("../src/services/configurationStore");
const { FlashService } = require("../src/services/flashService");
const { FaultService } = require("../src/services/faultService");
const { AgentService } = require("../src/services/agentService");
const { ElfService } = require("../src/services/elfService");
const { OpenOcdStatusService } = require("../src/services/openocdStatusService");
const { SkillStatusService, hasWorkspaceSkills } = require("../src/services/skillStatusService");
const { ChipInfoService } = require("../src/services/chipInfoService");
const { LiveWatchService } = require("../src/services/liveWatchService");
const { AgentOrchestrator } = require("../src/services/agentOrchestrator");

(async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-services-"));
    try {
        const elf = path.join(temp, "firmware.elf");
        fs.writeFileSync(elf, "elf");
        const state = new Map();
        const settings = new Map();
        const cacheKeys = { elfPath: "elf", debugger: "debugger", mcuCore: "mcu", svdPath: "svd" };
        const context = {
            workspaceState: {
                get: (key) => state.get(key),
                update: async (key, value) => state.set(key, value)
            }
        };
        let changed = 0;
        const vscode = {
            ConfigurationTarget: { Workspace: 2 },
            workspace: {
                workspaceFolders: [{ uri: { fsPath: temp } }],
                getConfiguration: () => ({
                    get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
                    update: async (key, value) => settings.set(key, value)
                })
            }
        };
        const store = new ConfigurationStore({
            vscode,
            context,
            cacheKeys,
            cleanPath: (value) => value.replace(/\\/g, "/"),
            isSafeCfg: (value) => typeof value === "string" && value.endsWith(".cfg") && !value.includes(".."),
            onChanged: () => {
                changed++;
            }
        });
        const snapshot = await store.update({
            elf: "firmware.elf",
            debugger: "cmsis-dap.cfg",
            mcu: "stm32f4x.cfg",
            sampleIntervalMs: 50
        });
        assert.ok(snapshot.elf.endsWith("/firmware.elf"));
        assert.strictEqual(snapshot.debugger, "cmsis-dap.cfg");
        assert.strictEqual(snapshot.sampleIntervalMs, 50);
        assert.strictEqual(changed, 1);
        await assert.rejects(
            () => store.update({ sampleIntervalMs: 1 }),
            (error) => error.code === "INVALID_CONFIG_VALUE"
        );

        // Agent Bridge 禁改键：openocdPath 可把探针调用引向任意可执行文件，必须拒绝
        assert.throws(
            () => assertAgentSettable({ openocdPath: "/tmp/evil" }),
            (error) => error.code === "CONFIG_KEY_FORBIDDEN" && error.retryable === false
        );
        assert.throws(
            () => assertAgentSettable({ mcu: "stm32f4x.cfg", openocdPath: "openocd" }),
            (error) => error.code === "CONFIG_KEY_FORBIDDEN"
        );
        assert.doesNotThrow(() => assertAgentSettable({ mcu: "stm32f4x.cfg", tclPort: 7777 }));
        assert.doesNotThrow(() => assertAgentSettable(undefined));

        let flashOptions;
        const flash = new FlashService({
            runOpenOcd: async (_vscode, options, progress) => {
                flashOptions = options;
                progress({ stage: "done" });
                return { ok: true };
            }
        });
        const progress = [];
        assert.deepStrictEqual(await flash.download({}, { elf }, (event) => progress.push(event)), { ok: true });
        assert.strictEqual(flashOptions.elf, elf);
        assert.deepStrictEqual(progress, [{ stage: "done" }]);

        const fault = new FaultService(
            {
                readFaultInfo: async () => ({
                    values: { cfsr: 1 },
                    targetState: "halted",
                    registers: {},
                    pc: "0x08000104",
                    lr: "0x08000200",
                    sp: "0x20001000",
                    xpsr: "0x01000000"
                }),
                decodeFaultRegisters: () => ({ faultDetected: true, faults: ["IACCVIOL"], exception: "HardFault" })
            },
            {
                nearestFunction: (_functions, address) => (address === 0x08000104 ? { name: "main", offset: 4 } : null)
            }
        );
        const faultResult = await fault.read({}, () => [{ name: "main" }]);
        assert.strictEqual(faultResult.pcSymbol, "main+0x4");
        assert.strictEqual(faultResult.faultDetected, true);

        class FakeBridge {
            constructor(workspace, handler, storageDir) {
                this.workspace = workspace;
                this.handler = handler;
                this.storageDir = storageDir;
                this.stopped = false;
            }
            async start() {
                return { workspace: this.workspace, storageDir: this.storageDir };
            }
            async stop() {
                this.stopped = true;
            }
        }
        const bridgeCalls = [];
        const agent = new AgentService({
            Bridge: FakeBridge,
            workspaceProvider: () => temp,
            storageDirProvider: () => path.join(temp, "global-storage"),
            onCall: (method) => bridgeCalls.push(method),
            handlers: {
                "config.get": async () => ({ ok: true }),
                "chip.read": async () => ({ core: "Cortex-M4", pc: "0x1", secret: "hidden" })
            }
        });
        assert.strictEqual(agent.isStarted(), false, "constructing the service must not create/start a bridge");
        assert.deepStrictEqual(await agent.call("config.get"), { ok: true });
        assert.deepStrictEqual(await agent.call("chip.read", { sections: ["runtime"] }), { pc: "0x1" });
        const capabilities = await agent.call("capabilities");
        assert.deepStrictEqual(capabilities.methods, ["config.get", "chip.read"]);
        await assert.rejects(
            () => agent.call("missing"),
            (error) => error.code === "METHOD_NOT_FOUND"
        );
        // onCall 钩子在每次调用前触发（capabilities 除外），供扩展侧做安全检查
        assert.deepStrictEqual(bridgeCalls, ["config.get", "chip.read"]);
        assert.deepStrictEqual(await agent.start(), { workspace: temp, storageDir: path.join(temp, "global-storage") });
        assert.strictEqual(agent.isStarted(), true);
        const bridge = agent.bridge;
        await agent.stop();
        assert.strictEqual(bridge.stopped, true);
        assert.strictEqual(agent.isStarted(), false);

        let dwarfParses = 0;
        const elfService = new ElfService({
            context: { workspaceState: { get: () => elf } },
            cacheKey: "elf",
            fs,
            crypto: require("crypto"),
            cleanPath: (value) => value,
            t: (key) => key,
            elfSymbols: {
                parseElfSymbols: () => ({ symbols: [{ name: "counter", size: 4 }], warnings: [] }),
                defaultType: () => "u32"
            },
            dwarf: {
                parseDwarf: () => {
                    dwarfParses++;
                    return {
                        types: new Map([["counter", { typeName: "unsigned int", watchType: "u32" }]]),
                        layouts: new Map()
                    };
                }
            }
        });
        const firstElf = elfService.read();
        assert.strictEqual(firstElf.symbols[0].hasDwarfWriteType, true);
        assert.strictEqual(elfService.read(), firstElf, "matching content hash should reuse the enriched result");
        assert.strictEqual(dwarfParses, 1);
        elfService.invalidate();
        elfService.read();
        assert.strictEqual(dwarfParses, 2);

        const statusEvents = [];
        const checker = {
            probeOpenOcd: async (target) => ({ found: true, path: target, requested: target, version: "1.0" }),
            setCache(result) {
                this.cached = result;
            },
            getCachedResult() {
                return this.cached;
            },
            resolveOpenOcdStatus: async (_target, _context, result, report) => {
                report({ state: "ready", result });
                return result.path;
            }
        };
        const statusService = new OpenOcdStatusService({
            vscode: {
                workspace: { getConfiguration: () => ({ get: () => "openocd" }) },
                commands: { executeCommand: () => {} }
            },
            context,
            checker,
            getLang: () => "en",
            onStatus: (status) => statusEvents.push(status)
        });
        assert.strictEqual(await statusService.refresh(), "openocd");
        assert.strictEqual(await statusService.resolve("openocd"), "openocd");
        assert.ok(statusEvents.some((event) => event.state === "ready"));
        checker.installBundledAndConfigure = async () => "/bundled/openocd";
        checker.pickOpenOcdPath = async () => "/picked/openocd";
        assert.strictEqual(await statusService.handleAction("install"), "/bundled/openocd");
        assert.strictEqual(await statusService.handleAction("select"), "/picked/openocd");
        checker.cached = { found: true, path: "old", requested: "old" };
        assert.strictEqual(await statusService.resolve("new-openocd"), "new-openocd");

        const skillEvents = [];
        const skillStatus = {
            state: "installed",
            scopes: { workspace: null, global: { state: "installed", installed: 2, total: 2, root: temp } }
        };
        const skillService = new SkillStatusService({
            vscode: { window: {}, commands: {}, workspace: { workspaceFolders: [] } },
            context,
            installer: { inspectSkills: async () => skillStatus },
            getLang: () => "en",
            t: (key, params) => (params ? `${key}:${params.installed}/${params.total}` : key),
            onStatus: (status) => skillEvents.push(status)
        });
        assert.strictEqual(await skillService.refresh(), skillStatus);
        assert.strictEqual(skillService.scopeStateText(skillStatus.scopes.global), "skill.installed:2/2");
        assert.deepStrictEqual(skillEvents, [skillStatus]);
        assert.strictEqual(hasWorkspaceSkills(skillStatus), false, "global Skills must not enable a workspace Bridge");
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "notInstalled" } } }), false);
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "installed" } } }), true);
        assert.strictEqual(hasWorkspaceSkills({ scopes: { workspace: { state: "partial" } } }), true);

        const skillCalls = [];
        const quickPicks = [{ id: "install:global" }, { id: "uninstall" }, { id: "global" }];
        const notices = [];
        const managedSkills = new SkillStatusService({
            vscode: {
                workspace: { workspaceFolders: [] },
                commands: { executeCommand: (command) => skillCalls.push(command) },
                window: {
                    showQuickPick: async () => quickPicks.shift(),
                    showWarningMessage: async (...args) => {
                        notices.push(args);
                        return args.at(-1);
                    },
                    showInformationMessage: async (...args) => {
                        notices.push(args);
                        return args.at(-1);
                    }
                }
            },
            context,
            installer: {
                inspectSkills: async () => skillStatus,
                installSkill: async (_vscode, _context, _lang, scope) => {
                    skillCalls.push(`install:${scope}`);
                    return skillStatus;
                },
                uninstallSkill: async (_vscode, _context, _lang, scope) => {
                    skillCalls.push(`uninstall:${scope}`);
                    return skillStatus;
                }
            },
            getLang: () => "en",
            t: (key) => key,
            onStatus: () => {}
        });
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.strictEqual(await managedSkills.manage(), skillStatus);
        assert.ok(skillCalls.includes("install:global") && skillCalls.includes("uninstall:global"));
        managedSkills.lastStatus = { state: "modified" };
        managedSkills.warnIfModified();
        managedSkills.promptUpgrade({ state: "outdated" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(notices.length >= 3);
        assert.ok(skillCalls.includes("mcu-vscode.manageAgentSkills"));

        const liveService = new LiveWatchService({
            decodeValue: (bytes, type) => `${type}:${bytes[0]}`,
            decodeComposite: () => ({ kind: "struct" })
        });
        const decoded = liveService.decodeSamples(
            [
                { name: "counter", bytes: [7] },
                { name: "sensor", bytes: [1, 2] }
            ],
            123,
            { graph: new Map([["counter", "u32"]]), sidebar: new Map([["counter", "i32"]]) },
            new Map([["sensor", { layout: { kind: "struct" } }]])
        );
        assert.strictEqual(decoded.graphSamples[0].value, "u32:7");
        assert.strictEqual(decoded.sidebarSamples[0].value, "i32:7");
        assert.strictEqual(decoded.compositeSamples[0].tree.kind, "struct");

        const active = new Set();
        const chipPosts = [];
        const chipService = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: (key) => (key === "debugger" ? "p.cfg" : "t.cfg") } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: { readChipInfo: async () => ({ core: "Cortex-M4" }) },
            coordinator: {
                isActive: (name) => active.has(name),
                setActive: (name, value) => (value ? active.add(name) : active.delete(name))
            },
            t: (key) => key,
            resolveExecutable: async (value) => value,
            commandContext: () => ({ cwd: temp }),
            onPost: (message) => chipPosts.push(message),
            onDiagnostics: () => {},
            isDebugActive: () => false
        });
        assert.deepStrictEqual(await chipService.read(), { core: "Cortex-M4" });
        assert.strictEqual(chipService.running, false);
        assert.ok(chipPosts.some((message) => message.type === "chipInfo"));
        active.add("download");
        assert.strictEqual(await chipService.read(), null);
        assert.ok(chipPosts.some((message) => message.key === "chip.busyDownload"));
        active.delete("download");

        const unavailableChip = new ChipInfoService({
            vscode: { workspace: { getConfiguration: () => ({ get: () => "openocd" }) } },
            context: { workspaceState: { get: () => "configured.cfg" } },
            cacheKeys: { debugger: "debugger", mcuCore: "target" },
            chipInfo: { readChipInfo: async () => ({}) },
            coordinator: {
                isActive: () => false,
                setActive: () => {}
            },
            t: (key) => key,
            resolveExecutable: async () => null,
            commandContext: () => ({ cwd: temp }),
            onPost: () => {},
            onDiagnostics: () => {},
            isDebugActive: () => false
        });
        await assert.rejects(
            () => unavailableChip.read(true),
            (error) => error.code === "OPENOCD_NOT_READY"
        );
        assert.ok(new AgentOrchestrator({ Bridge: FakeBridge, handlers: {} }) instanceof AgentService);

        console.log("Service boundary tests passed");
    } finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

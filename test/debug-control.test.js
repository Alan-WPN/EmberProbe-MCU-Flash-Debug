"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DebugSessionBridge } = require("../src/services/debugSessionBridge");
const { DebugControlService } = require("../src/services/debugControlService");

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}
class Location {
    constructor(uri, position) {
        this.uri = uri;
        this.range = { start: position };
    }
}
class SourceBreakpoint {
    constructor(location, enabled = true, condition, hitCondition, logMessage) {
        Object.assign(this, { location, enabled, condition, hitCondition, logMessage });
    }
}
class FunctionBreakpoint {
    constructor(functionName, enabled = true, condition, hitCondition, logMessage) {
        Object.assign(this, { functionName, enabled, condition, hitCondition, logMessage });
    }
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-debug-control-"));
    try {
        const source = path.join(root, "main.c");
        fs.writeFileSync(source, "int main(void) { return 0; }\n");
        const bridge = new DebugSessionBridge({ onStatus() {} });
        const requests = [];
        const session = {
            id: "debug-1",
            type: "cortex-debug",
            name: "Test debug",
            workspaceFolder: { uri: { fsPath: root, toString: () => `file://${root}` } },
            configuration: { name: "Test debug" },
            async customRequest(command, args) {
                requests.push({ command, args });
                if (command === "threads") return { threads: [{ id: 7, name: "main" }] };
                if (command === "pause") {
                    bridge.handleMessage(session, {
                        type: "event",
                        event: "stopped",
                        body: { reason: "pause", threadId: args.threadId }
                    });
                    return {};
                }
                if (command === "continue") {
                    bridge.handleMessage(session, {
                        type: "event",
                        event: "continued",
                        body: { threadId: args.threadId }
                    });
                    return {};
                }
                if (["next", "stepIn", "stepOut"].includes(command)) {
                    bridge.handleMessage(session, {
                        type: "event",
                        event: "continued",
                        body: { threadId: args.threadId }
                    });
                    bridge.handleMessage(session, {
                        type: "event",
                        event: "stopped",
                        body: { reason: "step", threadId: args.threadId }
                    });
                    return {};
                }
                if (command === "restart") {
                    bridge.handleMessage(session, { type: "event", event: "continued", body: { threadId: 7 } });
                    return {};
                }
                throw new Error(`unexpected request ${command}`);
            },
            async getDebugProtocolBreakpoint(breakpoint) {
                return { verified: true, line: breakpoint.location ? 4 : undefined };
            }
        };
        bridge.setWorkspace(session.workspaceFolder);
        bridge.attach(session);
        bridge.handleMessage(session, {
            type: "response",
            command: "initialize",
            success: true,
            body: {
                supportsReadMemoryRequest: true,
                supportsWriteMemoryRequest: true,
                supportsRestartRequest: true,
                supportsFunctionBreakpoints: true
            }
        });

        const breakpoints = [];
        const vscode = {
            Position,
            Location,
            SourceBreakpoint,
            FunctionBreakpoint,
            Uri: { file: (fsPath) => ({ fsPath }) },
            debug: {
                breakpoints,
                addBreakpoints(items) {
                    breakpoints.push(...items);
                },
                removeBreakpoints(items) {
                    for (const item of items) {
                        const index = breakpoints.indexOf(item);
                        if (index >= 0) breakpoints.splice(index, 1);
                    }
                },
                async stopDebugging(target) {
                    bridge.detach(target);
                    return true;
                }
            }
        };
        const service = new DebugControlService({
            vscode,
            debugBridge: bridge,
            workspaceProvider: () => root,
            startDebug: async () => true
        });

        assert.strictEqual(service.status().state, "running");
        const paused = await service.control({ action: "pause" });
        assert.strictEqual(paused.status.state, "paused");
        assert.strictEqual(paused.threadId, 7);
        assert.strictEqual(service.status().reason, "pause");
        const stepped = await service.control({ action: "stepOver" });
        assert.strictEqual(stepped.status.state, "paused");
        assert.strictEqual(stepped.status.reason, "step");
        await service.control({ action: "stepIn" });
        await service.control({ action: "stepOut" });
        const continued = await service.control({ action: "continue" });
        assert.strictEqual(continued.status.state, "running");
        await assert.rejects(
            () => service.control({ action: "continue" }),
            (error) => error.code === "TARGET_NOT_PAUSED"
        );
        const restarted = await service.control({ action: "restart" });
        assert.strictEqual(restarted.status.state, "running");
        assert(requests.some((item) => item.command === "restart"));

        await service.updateBreakpoints({ action: "add", type: "source", file: "main.c", line: 4 });
        await service.updateBreakpoints({ action: "add", type: "source", file: "main.c", line: 4 });
        assert.strictEqual(breakpoints.length, 1, "adding an existing source breakpoint should be idempotent");
        await service.updateBreakpoints({ action: "add", type: "function", function: "main" });
        assert.strictEqual(breakpoints.length, 2);
        const listed = await service.listBreakpoints();
        assert.strictEqual(listed.breakpoints[0].line, 4);
        assert.strictEqual(listed.breakpoints[0].verified, true);
        assert.strictEqual(listed.breakpoints[1].function, "main");
        await service.updateBreakpoints({ action: "disable", type: "source", file: source, line: 4 });
        assert.strictEqual(breakpoints.find((item) => item.location).enabled, false);
        await service.updateBreakpoints({ action: "enable", type: "source", file: source, line: 4 });
        assert.strictEqual(breakpoints.find((item) => item.location).enabled, true);
        await service.updateBreakpoints({ action: "remove", type: "function", function: "main" });
        assert.strictEqual(breakpoints.length, 1);
        await assert.rejects(
            () => service.updateBreakpoints({ action: "add", type: "source", file: "../outside.c", line: 1 }),
            (error) => error.code === "BREAKPOINT_PATH_OUTSIDE_WORKSPACE"
        );

        const stopped = await service.control({ action: "stop" });
        assert.strictEqual(stopped.status.state, "none");
        bridge.dispose();

        const startBridge = new DebugSessionBridge({ onStatus() {} });
        const startService = new DebugControlService({
            vscode,
            debugBridge: startBridge,
            workspaceProvider: () => root,
            startDebug: async () => {
                startBridge.attach(session);
                return true;
            }
        });
        const started = await startService.start();
        assert.strictEqual(started.alreadyActive, false);
        assert.strictEqual(started.status.state, "running");
        assert.strictEqual((await startService.start()).alreadyActive, true);
        startBridge.dispose();

        const conflict = new DebugSessionBridge({ onStatus() {} });
        conflict.attach(session);
        conflict.attach({ ...session, id: "debug-2" });
        const conflictService = new DebugControlService({
            vscode,
            debugBridge: conflict,
            workspaceProvider: () => root
        });
        await assert.rejects(
            () => conflictService.control({ action: "pause" }),
            (error) => error.code === "DEBUG_SESSION_CONFLICT"
        );
        conflict.dispose();

        const eventFirstBridge = new DebugSessionBridge({ onStatus() {}, controlTimeoutMs: 30 });
        const eventFirstSession = {
            ...session,
            id: "event-first",
            async customRequest(command, args) {
                if (command === "restart") {
                    eventFirstBridge.handleMessage(eventFirstSession, {
                        type: "event",
                        event: "continued",
                        body: { threadId: args.threadId || 7 }
                    });
                    return new Promise(() => {});
                }
                throw new Error(`unexpected request ${command}`);
            }
        };
        eventFirstBridge.setWorkspace(eventFirstSession.workspaceFolder);
        eventFirstBridge.attach(eventFirstSession);
        eventFirstBridge.handleMessage(eventFirstSession, {
            type: "response",
            command: "initialize",
            body: { supportsRestartRequest: true }
        });
        const eventConfirmedRestart = await eventFirstBridge.control("restart", 7);
        assert.strictEqual(eventConfirmedRestart.status.state, "running");
        assert.ok(
            eventConfirmedRestart.status.epoch > eventConfirmedRestart.before.epoch,
            "a conclusive state event must complete restart even when customRequest never settles"
        );
        eventFirstBridge.dispose();

        const pressureBridge = new DebugSessionBridge({ onStatus() {}, controlTimeoutMs: 30 });
        const pressureSession = {
            ...session,
            id: "pressure",
            async customRequest(command, args) {
                if (command === "pause") {
                    setImmediate(() =>
                        pressureBridge.handleMessage(pressureSession, {
                            type: "event",
                            event: "stopped",
                            body: { reason: "pause", threadId: args.threadId }
                        })
                    );
                    return new Promise(() => {});
                }
                if (command === "next") {
                    setImmediate(() =>
                        pressureBridge.handleMessage(pressureSession, {
                            type: "event",
                            event: "continued",
                            body: { threadId: args.threadId }
                        })
                    );
                    return new Promise(() => {});
                }
                throw new Error(`unexpected request ${command}`);
            }
        };
        pressureBridge.setWorkspace(pressureSession.workspaceFolder);
        pressureBridge.attach(pressureSession);
        const firstPause = pressureBridge.control("pause", 7);
        await assert.rejects(
            () => pressureBridge.control("pause", 7),
            (error) => error.code === "DEBUG_CONTROL_BUSY" && error.details.activeAction === "pause"
        );
        assert.strictEqual((await firstPause).status.state, "paused");
        await assert.rejects(
            () => pressureBridge.control("stepOver", 7),
            (error) =>
                error.code === "DEBUG_CONTROL_TIMEOUT" &&
                error.details.action === "stepOver" &&
                error.details.status.state === "running"
        );
        pressureBridge.dispose();

        const rejectedBridge = new DebugSessionBridge({ onStatus() {}, controlTimeoutMs: 1000 });
        const rejectedSession = {
            ...session,
            id: "rejected",
            async customRequest() {
                throw new Error("adapter rejected request");
            }
        };
        rejectedBridge.setWorkspace(rejectedSession.workspaceFolder);
        rejectedBridge.attach(rejectedSession);
        await assert.rejects(() => rejectedBridge.control("pause", 7), /adapter rejected request/);
        assert.strictEqual(rejectedBridge.stateWaiters.size, 0, "a rejected DAP request must cancel its state waiter");
        rejectedBridge.dispose();
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log("Debug control tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

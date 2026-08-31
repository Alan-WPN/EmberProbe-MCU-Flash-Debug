"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "mainViewProvider.js"), "utf8");
const debugBridge = fs.readFileSync(path.join(root, "src", "services", "debugSessionBridge.js"), "utf8");
const liveWatch = fs.readFileSync(path.join(root, "src", "liveWatch.js"), "utf8");
const combined = [extension, provider, debugBridge].join("\n");

assert(!/launch\.json/i.test(combined), "Cortex-Debug integration must not access launch.json");
assert.match(
    provider,
    /vscode\.debug\.startDebugging\(workspaceFolder, debugConfig, \{[\s\S]*?suppressDebugView:\s*true[\s\S]*?\}\)/,
    "EmberProbe-launched sessions must not automatically reveal the Run and Debug view"
);
assert.match(
    provider,
    /servertype:\s*["']external["']/,
    "EmberProbe-launched sessions should reuse the managed OpenOCD server"
);
assert.match(provider, /gdbTarget:\s*managed\.gdbTarget/);
assert.match(
    provider,
    /showDevDebugOutput:\s*["']none["']/,
    "managed sessions must suppress Cortex-Debug protocol logging"
);
assert.match(provider, /__emberprobeManagedToken/);
assert.strictEqual(
    (provider.match(/snapshotReady: this\._debugBridge\.hasSession \? this\._debugBridge\.snapshotReady/g) || [])
        .length,
    2,
    "reopened graph and sidebar views must receive the current paused snapshot freshness"
);
assert.match(provider, /new liveWatch\.ManagedOpenOcdSession/);
assert.match(liveWatch, /bindto 127\.0\.0\.1/);
assert.match(liveWatch, /gdb_port \$\{gdbPort\}/);
assert.match(liveWatch, /tcl_port \$\{port\}/);
assert.match(liveWatch, /telnet_port disabled/);
assert.match(liveWatch, /configure -work-area-backup 1/);
assert.ok(liveWatch.indexOf("configure -work-area-backup 1") < liveWatch.lastIndexOf('"init"'));
assert.match(extension, /registerDebugConfigurationProvider\("cortex-debug"/);
assert.match(
    extension,
    /return config;/,
    "the Cortex-Debug resolver must return the in-memory configuration unchanged"
);
assert.match(extension, /registerDebugAdapterTrackerFactory\("cortex-debug"/);
assert.match(
    extension,
    /onWillReceiveMessage:[\s\S]*handleDebugAdapterRequest/,
    "execution requests must quiesce managed Tcl sampling before Cortex-Debug receives them"
);
assert.match(
    extension,
    /async function deactivate\(\)[\s\S]*await provider\.shutdown\(\)/,
    "Reload Window must await graceful OpenOCD shutdown"
);
assert.match(debugBridge, /message\.event === "stopped"/);
assert.match(debugBridge, /message\.event === "continued"/);
assert.match(
    provider,
    /event\.transition && event\.transition !== ["']continue["']/,
    "step and reset continuations must not restart runtime Tcl sampling"
);
assert.doesNotMatch(debugBridge, /customRequest\(["']pause["']/i, "runtime waiting must never pause the target");
assert.match(debugBridge, /snapshotReady/);
assert.match(debugBridge, /SNAPSHOT_RETRY_DELAYS_MS/);
assert.ok(
    provider.indexOf("await this.prepareForCortexDebug(workspaceFolder)") <
        provider.indexOf("this._debugStarting = true"),
    "live watch must release the probe before debug start claims it"
);
assert.match(
    provider,
    /debugConfig\.objdumpPath = cortexTools\.objdumpPath/,
    "the in-memory config should pass an existing objdump/nm toolchain pair"
);
assert.match(
    provider,
    /setWorkspace\(session\.workspaceFolder \|\| this\._commandContext\(\)\.folder\)/,
    "multi-root debug sessions must use the folder supplied by VS Code"
);

console.log("Cortex-Debug integration contract tests passed");

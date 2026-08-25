"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const extension = fs.readFileSync(path.join(root, "src", "extension.js"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "mainViewProvider.js"), "utf8");
const debugBridge = fs.readFileSync(path.join(root, "src", "services", "debugSessionBridge.js"), "utf8");
const combined = [extension, provider, debugBridge].join("\n");

assert(!/launch\.json/i.test(combined), "Cortex-Debug integration must not access launch.json");
assert.match(provider, /vscode\.debug\.startDebugging\(workspaceFolder, debugConfig\)/);
assert.match(extension, /registerDebugConfigurationProvider\("cortex-debug"/);
assert.match(extension, /return config;/, "the Cortex-Debug resolver must return the in-memory configuration unchanged");
assert.match(extension, /registerDebugAdapterTrackerFactory\("cortex-debug"/);
assert.match(extension, /async function deactivate\(\)[\s\S]*await provider\.shutdown\(\)/, "Reload Window must await graceful OpenOCD shutdown");
assert.match(debugBridge, /message\.event === "stopped"/);
assert.match(debugBridge, /message\.event === "continued"/);
assert.doesNotMatch(debugBridge, /customRequest\(["']pause["']/i, "runtime waiting must never pause the target");
assert.match(debugBridge, /snapshotReady/);
assert.match(debugBridge, /SNAPSHOT_RETRY_DELAYS_MS/);
assert.ok(provider.indexOf("await this.prepareForCortexDebug(workspaceFolder)") < provider.indexOf("this._debugStarting = true"), "live watch must release the probe before debug start claims it");
assert.match(provider, /debugConfig\.objdumpPath = cortexTools\.objdumpPath/, "the in-memory config should pass an existing objdump/nm toolchain pair");

console.log("Cortex-Debug integration contract tests passed");

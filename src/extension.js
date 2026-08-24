"use strict";

Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;

const vscode = require("vscode");
const openocdChecker = require("./openocdChecker");
const { MainViewProvider } = require("./mainViewProvider");
let activeProvider = null;

function activate(context) {
    console.log("MCU_VSCODE 下载与调试器已激活！");
    const provider = new MainViewProvider(context);
    activeProvider = provider;

    const subscriptions = [
        vscode.window.registerWebviewViewProvider("mcu-vscode.mainView", provider),
        vscode.commands.registerCommand("mcu-vscode.folderDebug", resource => provider.commandHandlers["mcu-vscode.debug"](resource)),
        vscode.commands.registerCommand("mcu-vscode.folderDownload", resource => provider.commandHandlers["mcu-vscode.download"](resource)),
        vscode.commands.registerCommand("mcu-vscode.openLiveWatch", () => provider.commandHandlers["mcu-vscode.openLiveWatch"]()),
        vscode.commands.registerCommand("mcu-vscode.manageAgentSkills", () => provider.commandHandlers["mcu-vscode.manageAgentSkills"]()),
        vscode.commands.registerCommand("mcu-vscode.checkOpenOcd", async () => {
            await vscode.commands.executeCommand("workbench.view.extension.mcu-vscode-container");
            await provider.refreshOpenOcdStatus(true);
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("emberprobe.openocdPath")) {
                openocdChecker.resetCache();
                provider.refreshOpenOcdStatus(true);
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await provider.stopAgentBridge().catch(() => {});
            provider.refreshSkillStatus().catch(() => {});
        }),
        {
            dispose: () => {
                provider.stopLiveWatch();
                provider.stopAgentReadIfRunning();
                provider.stopAgentBridge().catch(() => {});
            }
        },
        vscode.debug.onDidStartDebugSession(session => {
            if (session && session.type === "cortex-debug") {
                provider.stopLiveWatchIfRunning();
                provider.stopAgentReadIfRunning();
            }
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
            if (session && session.type === "cortex-debug") provider.stopLiveWatchIfRunning();
        })
    ];
    context.subscriptions.push(...subscriptions);

    provider.refreshOpenOcdStatus(false);
    provider.refreshSkillStatus().catch(() => {});
}

async function deactivate() {
    const provider = activeProvider;
    activeProvider = null;
    if (provider) {
        provider.stopLiveWatch();
        provider.stopAgentReadIfRunning();
        await provider.stopAgentBridge().catch(() => {});
    }
    console.log("MCU_VSCODE 下载与调试器已停用！");
}

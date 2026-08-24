"use strict";

const { spawn } = require("child_process");
const { resolveOpenOcdLaunch } = require("../openocdScripts");

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function openOcdNotFound(executable) {
    return Object.assign(new Error(`找不到 OpenOCD：${executable}`), {
        i18nKey: "run.notFound",
        i18nParams: { path: executable }
    });
}

function normalizeSpawnError(error, executable) {
    return error && error.code === "ENOENT"
        ? openOcdNotFound(executable)
        : new Error(error && error.message ? error.message : String(error));
}

// 执行一次性 OpenOCD 任务：构造 -f/-c 参数、拆分 stdout/stderr 行、
// 统一 ANSI 清理、超时、ENOENT 语义与日志尾部留存。
// resolve { exitCode, openocdTail, commands }；OpenOCD 非零退出码由业务层结合解析结果判定。
function runOpenOcdOnce(options) {
    const commands = options.buildCommands();
    let launch;
    try {
        launch = (options.resolveLaunch || resolveOpenOcdLaunch)(options.executable, options.probe, options.target);
    } catch (error) {
        return Promise.reject(error);
    }
    const args = ["-s", launch.scriptsRoot, "-f", launch.probePath, "-f", launch.targetPath];
    for (const command of commands) args.push("-c", command);
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 15000;
    const tailLimit = Number(options.tailLimit) > 0 ? Number(options.tailLimit) : 20;
    const spawnImpl = options.spawnImpl || spawn;

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(launch.executable, args, {
                cwd: launch.cwd,
                windowsHide: true,
                shell: false
            });
        } catch (error) {
            reject(normalizeSpawnError(error, launch.executable));
            return;
        }

        const openocdTail = [];
        let pending = "";
        let settled = false;

        const finish = (error, exitCode) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve({ exitCode, openocdTail: openocdTail.slice(), commands: commands.slice() });
        };
        const handleLine = (raw) => {
            const clean = String(raw).replace(ANSI_RE, "").replace(/\r/g, "").trim();
            if (!clean) return;
            openocdTail.push(clean.slice(0, 500));
            if (openocdTail.length > tailLimit) openocdTail.shift();
            if (typeof options.onLine === "function") options.onLine(clean);
        };
        const consume = (chunk) => {
            pending += chunk.toString();
            const lines = pending.split(/\r?\n/);
            pending = lines.pop() || "";
            for (const line of lines) handleLine(line);
        };
        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch (error) {
                // 进程可能已经退出，保留原超时语义。
            }
            const timeoutError =
                typeof options.buildTimeoutError === "function"
                    ? options.buildTimeoutError(timeoutMs)
                    : Object.assign(new Error(`OpenOCD 执行超时（${timeoutMs}ms）`), { code: "OPENOCD_TIMEOUT" });
            finish(timeoutError);
        }, timeoutMs);

        child.stdout.on("data", consume);
        child.stderr.on("data", consume);
        child.on("error", (error) => finish(normalizeSpawnError(error, launch.executable)));
        child.on("close", (code) => {
            if (pending) {
                handleLine(pending);
                pending = "";
            }
            finish(null, code);
        });
    });
}

module.exports = { runOpenOcdOnce, openOcdNotFound, normalizeSpawnError };

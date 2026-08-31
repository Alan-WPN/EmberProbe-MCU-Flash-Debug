"use strict";
// 将片上 Flash 与本地 ELF 比对（OpenOCD verify_image）：halt 目标、校验、恢复原运行状态。
// 先输出预检 JSON，--execute 输出 {verified, elf, elfSha256, detail} 并以退出码反映结果。
const fs = require("fs");
const {
    parseArgs,
    preflight,
    emit,
    sha256,
    isSafeCfgPath,
    resolveOpenOcdLaunch,
    tclQuote,
    toPosix,
    runOpenOcd
} = require("../../_emberprobe/flash-common");

function fail(message) {
    process.stderr.write(message + "\n");
    process.exit(1);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await preflight(options);
    emit(result);
    if (!result.ready) fail("Detection incomplete. Provide or select ELF, target, and probe.");
    if (!fs.existsSync(result.elf)) fail(`ELF not found: ${result.elf}`);
    if (!isSafeCfgPath(result.target) || !isSafeCfgPath(result.probe)) fail("Unsafe OpenOCD configuration path.");
    if (!options.execute) return;
    if (!result.openocdCompatible) {
        fail(
            `Incompatible OpenOCD ${result.openocdVersion || "(unknown version)"}; EmberProbe requires ${result.minimumOpenocdVersion} or newer. Upgrade OpenOCD${process.platform === "win32" ? " or select EmberProbe's bundled xPack build" : ""}.`
        );
    }
    const currentHash = await sha256(result.elf);
    if (currentHash !== result.elfSha256) {
        fail("ELF changed during verify preflight. Retry so the comparison stays consistent.");
    }
    let launch;
    try {
        launch = resolveOpenOcdLaunch(result.openocd, result.probe, result.target);
    } catch (error) {
        fail(`${error.message} (${error.code || "OPENOCD_CONFIGURATION_ERROR"})`);
    }
    const elfWord = tclQuote(toPosix(result.elf));
    // target checksum 算法会申请 work-area，而很多 target cfg 将它放在 RAM 起始且 backup=0。
    // 校验前将当前 target 的 work-area 置为 0，促使 OpenOCD 0.12 回退到主机分块读取比对，
    // 避免 verify_image 把 .data/.bss 当作临时缓冲区。
    const disableWorkArea = "set _ep_target [target current]; $_ep_target configure -work-area-size 0";
    // 严格保存原运行状态：halt 失败时不执行 verify；由本脚本 halt 的 target 无论成败都尝试 resume。
    const verify =
        'set o [[target current] curstate]; set h 0; set rc 0; set msg ""; ' +
        'if {$o ne "halted"} { set rc [catch {halt} msg]; if {!$rc} { set h 1 } }; ' +
        `if {!$rc} { set rc [catch { verify_image ${elfWord} } msg] }; ` +
        "if {$h} { set rrc [catch {resume} rmsg]; if {!$rc && $rrc} { set rc $rrc; set msg $rmsg } }; " +
        'if {$rc} { echo "EP_VERIFY FAIL $msg" } else { echo "EP_VERIFY OK" }; shutdown';
    let run;
    try {
        run = await runOpenOcd(
            launch.executable,
            [
                "-s",
                launch.scriptsRoot,
                "-f",
                launch.probePath,
                "-f",
                launch.targetPath,
                "-c",
                "bindto 127.0.0.1",
                "-c",
                "tcl_port disabled",
                "-c",
                "gdb_port disabled",
                "-c",
                "telnet_port disabled",
                "-c",
                disableWorkArea,
                "-c",
                "init",
                "-c",
                verify
            ],
            { cwd: launch.cwd, timeoutMs: 120000 }
        );
    } catch (error) {
        fail(`Failed to start OpenOCD (${error.code || error.message}). Check the openocd executable or path.`);
    }
    // 标记行以行首锚定匹配：避免把回显参数/日志中携带的 Tcl 文本误判为结果
    const okLine = run.lines.find((line) => /^\s*EP_VERIFY OK\b/.test(line));
    const failLine = run.lines.find((line) => /^\s*EP_VERIFY FAIL\b/.test(line));
    const verified = Boolean(okLine && !failLine && run.code === 0);
    const detail = failLine
        ? failLine.replace(/^.*EP_VERIFY FAIL\s*/, "").trim()
        : run.code !== 0
          ? `OpenOCD exited with code ${run.code}`
          : "";
    emit({ verified, elf: result.elf, elfSha256: result.elfSha256, detail });
    if (!okLine && !failLine) {
        fail("OpenOCD did not reach the verification step. Check probe connection and target power.");
    }
    process.exitCode = verified ? 0 : 1;
}

if (require.main === module)
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });

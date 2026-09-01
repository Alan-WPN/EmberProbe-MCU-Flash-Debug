"use strict";
// 将工作区 ELF 固件烧录到 MCU（OpenOCD program ... verify reset exit）。
// 先输出预检 JSON（含检测到的 ELF/目标/探针/OpenOCD），--execute 才真正执行烧录。
const fs = require("fs");
const {
    parseArgs,
    preflight,
    emit,
    sha256,
    isSafeCfgPath,
    resolveOpenOcdLaunch,
    authorizeFlash,
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
    if (!result.ready) fail("Detection incomplete. Provide or select ELF, target, and probe.");
    if (!fs.existsSync(result.elf)) fail(`ELF not found: ${result.elf}`);
    if (!isSafeCfgPath(result.target) || !isSafeCfgPath(result.probe)) fail("Unsafe OpenOCD configuration path.");
    let authorization;
    try {
        authorization = await authorizeFlash(result, options["confirmation-id"]);
    } catch (error) {
        if (!options.execute) {
            emit({
                ...result,
                flashAuthorization: {
                    unavailable: true,
                    code: error.code || "BRIDGE_UNAVAILABLE",
                    message: "Execution requires one-time authorization from the EmberProbe extension Bridge"
                }
            });
            return;
        }
        fail(
            `EmberProbe flash authorization failed (${error.code || error.message}). Open the trusted workspace and reinstall its EmberProbe Agent Skills.`
        );
    }
    emit({ ...result, flashAuthorization: authorization });
    if (!options.execute) return;
    if (!authorization || authorization.authorized !== true) {
        fail(
            "Flash confirmation is required. Show the preflight details to the user, then rerun with --execute --confirmation-id <id> only after explicit approval."
        );
    }
    if (!result.openocdCompatible) {
        fail(
            `Incompatible OpenOCD ${result.openocdVersion || "(unknown version)"}; EmberProbe requires ${result.minimumOpenocdVersion} or newer. Upgrade OpenOCD${process.platform === "win32" ? " or select EmberProbe's bundled xPack build" : ""}.`
        );
    }
    const currentHash = await sha256(result.elf);
    if (currentHash !== result.elfSha256) {
        fail("ELF changed during download preflight. Retry so addresses and firmware stay consistent.");
    }
    let launch;
    try {
        launch = resolveOpenOcdLaunch(result.openocd, result.probe, result.target);
    } catch (error) {
        fail(`${error.message} (${error.code || "OPENOCD_CONFIGURATION_ERROR"})`);
    }
    const program = `program ${tclQuote(toPosix(result.elf))} verify reset exit`;
    // flash driver 仍可使用 target work-area 加速，但必须在操作后恢复原 RAM 内容。
    const preserveWorkArea = "foreach _ep_target [target names] { $_ep_target configure -work-area-backup 1 }";
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
                preserveWorkArea,
                "-c",
                program
            ],
            { cwd: launch.cwd, timeoutMs: 120000 }
        );
    } catch (error) {
        fail(`Failed to start OpenOCD (${error.code || error.message}). Check the openocd executable or path.`);
    }
    process.exit(run.code);
}

if (require.main === module)
    main().catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });

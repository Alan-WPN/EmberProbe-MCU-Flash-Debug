"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { siblingNm, resolveCortexToolchain } = require("../src/services/cortexToolchainService");

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "emberprobe-cortex-tools-")));
try {
    const touch = name => {
        const file = path.join(root, name);
        fs.writeFileSync(file, "tool");
        fs.chmodSync(file, 0o755);
        return file;
    };
    const objdump = touch("arm-none-eabi-objdump");
    const nm = touch("arm-none-eabi-nm");
    assert.strictEqual(siblingNm(objdump), nm);
    assert.deepStrictEqual(resolveCortexToolchain({ envPath: root, platform: "linux" }), { objdumpPath: objdump, nmPath: nm });
    assert.deepStrictEqual(
        resolveCortexToolchain({ configuredObjdump: path.join(root, "objdump-multiarch"), envPath: root, platform: "linux" }),
        { objdumpPath: objdump, nmPath: nm },
        "a missing multiarch pair should fall back to a complete arm-none-eabi pair"
    );
    console.log("Cortex toolchain tests passed");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

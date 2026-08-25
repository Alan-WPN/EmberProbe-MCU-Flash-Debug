"use strict";
const assert = require("assert");
const { EventEmitter } = require("events");
const { LiveWatchSession } = require("../src/liveWatch");
const { FakeOpenOcdServer } = require("./helpers/fake-openocd-server");

(async () => {
    const fake = new FakeOpenOcdServer();
    await fake.start();
    fake.seed(0x20000000, [1, 2, 3, 4, 5, 6]);

    const session = new LiveWatchSession(null, {}, {});
    session.socket = await fake.connect();
    session._setupSocket();

    try {
        const samples = await session.readOnce([
            { name: "head", address: 0x20000000, size: 2 },
            { name: "tail", address: 0x20000002, size: 4 }
        ]);
        assert.deepStrictEqual(samples.map(sample => ({ name: sample.name, bytes: sample.bytes })), [
            { name: "head", bytes: [1, 2] },
            { name: "tail", bytes: [3, 4, 5, 6] }
        ]);
        assert.deepStrictEqual(
            fake.commands.filter(command => command.includes("read_memory")),
            ["ocd_read_memory 0x20000000 16 3"],
            "contiguous variables should be read in one Tcl command"
        );

        const transaction = await session.writeAndVerify([
            { name: "pair", address: 0x20000001, bytes: [0xaa, 0xbb] }
        ]);
        assert.deepStrictEqual(transaction.before[0].bytes, [2, 3]);
        assert.deepStrictEqual(transaction.after[0].bytes, [0xaa, 0xbb]);
        assert.deepStrictEqual(fake.bytes(0x20000000, 4), [1, 0xaa, 0xbb, 4]);
        assert.ok(
            fake.commands.includes("ocd_write_memory 0x20000000 32 {0x4bbaa01}"),
            "unaligned byte changes should use a preserving aligned word write"
        );
        assert.deepStrictEqual(fake.commands.filter(command => command === "halt" || command === "resume"), ["halt", "resume"]);
        assert.strictEqual(fake.state, "running", "write transaction should restore the target run state");
    } finally {
        await session.stop();
        await fake.stop();
    }

    // Reload Window 停用扩展时必须先让 OpenOCD 收到 shutdown 并退出，不能立即断 socket/杀进程。
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = signal => { child.killed = true; child.lastSignal = signal || "SIGTERM"; return true; };
    let shutdownFrame = "";
    const graceful = new LiveWatchSession(null, {}, {});
    graceful.child = child;
    graceful.socket = {
        destroyed: false,
        write(data, callback) {
            shutdownFrame = data;
            setImmediate(() => {
                callback();
                child.exitCode = 0;
                child.emit("close", 0);
            });
        },
        destroy() { this.destroyed = true; }
    };
    const gracefulStop = graceful.stop(100);
    assert.strictEqual(graceful.stopped, true, "stop should synchronously prevent more samples");
    assert.strictEqual(child.killed, false, "OpenOCD should get a graceful shutdown opportunity before signals are sent");
    assert.strictEqual(await gracefulStop, true);
    assert.strictEqual(shutdownFrame, "shutdown\x1a");
    assert.strictEqual(child.killed, false, "a clean OpenOCD exit must not be followed by a kill signal");

    // 芯片复位导致的瞬时读取错误，在下一次完整采样成功后必须清除并恢复正常显示。
    const recoveryStatuses = [];
    const recoveryErrors = [];
    const recoverySamples = [];
    const recovering = new LiveWatchSession(null, {}, {
        onStatus: status => recoveryStatuses.push(status),
        onError: error => recoveryErrors.push(error),
        onSample: samples => recoverySamples.push(samples)
    });
    recovering.socket = { destroyed: false };
    recovering.watch = [{ name: "counter", address: 0x20000000, size: 4 }];
    let recoveryAttempt = 0;
    recovering._readItems = async (_items, timestamp) => {
        recoveryAttempt++;
        if (recoveryAttempt === 1) throw new Error("target reset during read");
        return { samples: [{ name: "counter", bytes: [2, 0, 0, 0], timestamp }], ok: 1 };
    };
    await recovering._sampleTick();
    assert.deepStrictEqual(recoveryErrors, ["target reset during read"]);
    assert.strictEqual(recovering._sampleErrorActive, true);
    await recovering._sampleTick();
    assert.strictEqual(recovering._sampleErrorActive, false);
    assert.strictEqual(recoverySamples.length, 1);
    assert.deepStrictEqual(recoveryStatuses, [{ key: "sb.sampling" }]);

    console.log("Live watch Tcl-RPC integration tests passed");
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

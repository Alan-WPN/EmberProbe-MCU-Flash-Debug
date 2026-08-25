"use strict";

const MIN_DAP_INTERVAL_MS = 250;
const MAX_READ_BYTES = 4096;
const SNAPSHOT_INITIAL_DELAY_MS = 180;
const SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([150, 300, 600, 1000]);

function sessionFolderKey(session) {
    return session?.workspaceFolder?.uri?.toString?.() || "";
}

function unwrapResponse(value) {
    return value && typeof value === "object" && value.body && typeof value.body === "object"
        ? value.body
        : value || {};
}

function mergeReadPlan(items, maxBytes = MAX_READ_BYTES) {
    const sorted = (items || [])
        .filter((item) => Number.isFinite(Number(item.address)) && Number(item.size) > 0)
        .map((item) => ({ ...item, address: Number(item.address), size: Number(item.size) }))
        .sort((a, b) => a.address - b.address || a.size - b.size);
    const groups = [];
    for (const item of sorted) {
        const last = groups[groups.length - 1];
        const end = item.address + item.size;
        if (last && item.address <= last.address + last.size && end - last.address <= maxBytes) {
            last.size = Math.max(last.size, end - last.address);
            last.items.push(item);
        } else {
            groups.push({ address: item.address, size: item.size, items: [item] });
        }
    }
    return groups;
}

class DebugSessionBridge {
    constructor(options = {}) {
        this.getReadPlan = options.getReadPlan || (() => []);
        this.getIntervalMs = options.getIntervalMs || (() => MIN_DAP_INTERVAL_MS);
        this.onSamples = options.onSamples || (() => {});
        this.onStatus = options.onStatus || (() => {});
        this.onError = options.onError || (() => {});
        this.allSessions = new Map();
        this.sessions = new Map();
        this.intentEnabled = false;
        this.workspaceKey = "";
        this.paused = false;
        this.capabilities = { read: null, write: null };
        this.epoch = 0;
        this.timer = null;
        this.polling = false;
        this.writing = false;
        this.consecutiveErrors = 0;
        this.snapshotPending = false;
        this.snapshotReady = false;
    }

    get activeSession() {
        if (this.sessions.size !== 1) return null;
        return this.sessions.values().next().value;
    }

    get hasSession() {
        return this.sessions.size > 0;
    }
    get hasAnySession() {
        return this.allSessions.size > 0;
    }
    get conflict() {
        return this.sessions.size > 1;
    }
    get canRead() {
        return !!(this.intentEnabled && this.paused && !this.conflict && this.activeSession && this.capabilities.read);
    }
    get canWrite() {
        return !!(this.canRead && this.snapshotReady && this.capabilities.write);
    }

    status(extra = {}) {
        let mode = "standalone-sampling";
        let key = this.intentEnabled ? "sb.sampling" : "sb.stopped";
        let source = "openocd";
        if (this.conflict || (this.allSessions.size && !this.hasSession)) {
            mode = "debug-session-conflict";
            key = "live.debugConflict";
            source = "dap";
        } else if (this.hasSession) {
            source = "dap";
            if (!this.paused) {
                mode = "debug-running-waiting";
                key = "live.debugWaiting";
            } else if (!this.intentEnabled) {
                mode = "debug-disabled";
                key = "sb.stopped";
            } else if (this.capabilities.read === false) {
                mode = "debug-paused-unsupported";
                key = "live.dapReadUnsupported";
            } else if (!this.snapshotReady) {
                mode = "debug-paused-reading";
                key = "live.dapReading";
            } else {
                mode = "debug-paused-ready";
                key = "live.dapReady";
            }
        }
        return {
            running: this.intentEnabled,
            mode,
            intentEnabled: this.intentEnabled,
            canRead: this.canRead,
            canWrite: this.canWrite,
            snapshotReady: this.snapshotReady,
            source,
            key,
            ...extra
        };
    }

    setWorkspace(folder) {
        this.workspaceKey = folder?.uri?.toString?.() || folder?.toString?.() || "";
        this._recomputeSessions();
    }

    attach(session) {
        if (!session || session.type !== "cortex-debug") return;
        this.allSessions.set(session.id, session);
        this._recomputeSessions();
    }

    detach(session) {
        if (!session) return;
        this.allSessions.delete(session.id);
        this._recomputeSessions();
    }

    _recomputeSessions() {
        const previous = [...this.sessions.keys()].sort().join("|");
        const matching = [...this.allSessions.entries()].filter(([, session]) => {
            const key = sessionFolderKey(session);
            return !this.workspaceKey || !key || key === this.workspaceKey;
        });
        this.sessions = new Map(matching);
        const current = [...this.sessions.keys()].sort().join("|");
        if (previous !== current) {
            this.paused = false;
            this.capabilities = { read: null, write: null };
            this.snapshotPending = false;
            this.snapshotReady = false;
            this._invalidate();
        }
        this.onStatus(this.status());
    }

    setIntent(enabled) {
        const changed = this.intentEnabled !== !!enabled;
        this.intentEnabled = !!enabled;
        if (changed) {
            this._invalidate();
            this.snapshotReady = false;
            this.snapshotPending = this.intentEnabled && this.paused;
            this.consecutiveErrors = 0;
        }
        this.onStatus(this.status());
        this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
    }

    refreshSnapshot() {
        if (!this.intentEnabled || !this.paused || !this.hasSession || this.conflict) return;
        this._invalidate();
        this.consecutiveErrors = 0;
        this.snapshotReady = false;
        this.snapshotPending = true;
        this.onStatus(this.status());
        this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
    }

    handleMessage(session, message) {
        if (!session || !this.sessions.has(session.id) || !message) return;
        if (message.type === "response" && message.command === "initialize" && message.success !== false) {
            const body = unwrapResponse(message);
            this.capabilities.read = body.supportsReadMemoryRequest === true;
            this.capabilities.write = body.supportsWriteMemoryRequest === true;
            if (this.intentEnabled && this.paused && this.capabilities.read && !this.snapshotReady)
                this.snapshotPending = true;
            this.onStatus(this.status());
            this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
            return;
        }
        if (message.type !== "event") return;
        if (message.event === "stopped") {
            this.paused = true;
            this.consecutiveErrors = 0;
            this._invalidate();
            this.snapshotReady = false;
            this.snapshotPending = this.intentEnabled;
            this.onStatus(this.status());
            this._schedule(SNAPSHOT_INITIAL_DELAY_MS);
        } else if (message.event === "continued") {
            this.paused = false;
            this._invalidate();
            this.snapshotPending = false;
            this.snapshotReady = false;
            this.onStatus(this.status());
        } else if (message.event === "terminated" || message.event === "exited") {
            this.paused = false;
            this._invalidate();
            this.snapshotPending = false;
            this.snapshotReady = false;
            this.onStatus(this.status({ mode: "restoring", key: "live.restoring" }));
        }
    }

    _invalidate() {
        this.epoch += 1;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    _schedule(delay) {
        if (!this.canRead || !this.snapshotPending || this.snapshotReady || this.polling || this.writing || this.timer)
            return;
        this.timer = setTimeout(
            () => {
                this.timer = null;
                this._poll().catch((error) => this.onError(error));
            },
            Math.max(0, delay)
        );
    }

    async _poll() {
        if (!this.canRead || !this.snapshotPending || this.snapshotReady || this.polling) return;
        const plan = this.getReadPlan() || [];
        if (!plan.length) {
            this.onStatus(this.status({ key: "live.needVar" }));
            return;
        }
        const session = this.activeSession;
        const epoch = this.epoch;
        this.polling = true;
        try {
            const samples = await this.read(plan, session);
            if (epoch !== this.epoch || !this.canRead || session !== this.activeSession) return;
            this.consecutiveErrors = 0;
            this.snapshotPending = false;
            this.snapshotReady = true;
            this.onSamples(samples, Date.now());
            this.onStatus(this.status());
        } catch (error) {
            if (epoch !== this.epoch) return;
            this.consecutiveErrors += 1;
            const retryDelay = SNAPSHOT_RETRY_DELAYS_MS[this.consecutiveErrors - 1];
            if (retryDelay === undefined) {
                this.snapshotPending = false;
                this.snapshotReady = false;
                this.onError(error);
                this.onStatus(this.status({ key: "live.dapFailed", error: true, message: error.message }));
            } else {
                this.snapshotPending = true;
                this.onStatus(this.status({ key: "live.dapRetrying" }));
            }
        } finally {
            this.polling = false;
            const retryDelay = SNAPSHOT_RETRY_DELAYS_MS[this.consecutiveErrors - 1];
            if (this.snapshotPending && !this.snapshotReady)
                this._schedule(retryDelay === undefined ? SNAPSHOT_INITIAL_DELAY_MS : retryDelay);
        }
    }

    async _readBlock(session, address, count) {
        const result = unwrapResponse(
            await session.customRequest("readMemory", {
                memoryReference: `0x${address.toString(16)}`,
                offset: 0,
                count
            })
        );
        if (!result.data) throw new Error(`DAP readMemory returned no data for 0x${address.toString(16)}`);
        const data = Uint8Array.from(Buffer.from(result.data, "base64"));
        if (!data.length) throw new Error(`DAP readMemory returned an empty block for 0x${address.toString(16)}`);
        return data;
    }

    async read(items, session = this.activeSession) {
        if (!session || this.conflict) throw new Error("No unique Cortex-Debug session is available");
        if (!this.capabilities.read) throw new Error("Cortex-Debug does not support DAP readMemory");
        const samples = [];
        for (const group of mergeReadPlan(items)) {
            const data = await this._readBlock(session, group.address, group.size);
            for (const item of group.items) {
                const offset = item.address - group.address;
                const bytes = data.slice(offset, Math.min(data.length, offset + item.size));
                if (bytes.length !== item.size) throw new Error(`DAP partially read ${item.name}`);
                samples.push({ name: item.name, bytes });
            }
        }
        return samples;
    }

    async writeAndVerify(items) {
        const session = this.activeSession;
        if (!this.canWrite || !session)
            throw new Error("Cortex-Debug target must be paused and support DAP writeMemory");
        this._invalidate();
        const waitDeadline = Date.now() + 2000;
        while (this.polling && this.canWrite && Date.now() < waitDeadline)
            await new Promise((resolve) => setTimeout(resolve, 5));
        if (this.polling) throw new Error("A DAP memory read is still in progress; write was not started");
        if (!this.canWrite || session !== this.activeSession)
            throw new Error("Target continued before the DAP write could start");
        this.writing = true;
        this._invalidate();
        const epoch = this.epoch;
        const plan = items.map((item) => ({ ...item, size: item.bytes.length }));
        try {
            const before = await this.read(plan, session);
            for (const item of items) {
                if (epoch !== this.epoch || !this.canWrite)
                    throw new Error("Target continued while a DAP write was in progress");
                const address = Number(item.address);
                const alignedStart = Math.floor(address / 4) * 4;
                const alignedEnd = Math.ceil((address + item.bytes.length) / 4) * 4;
                const alignedBytes = await this._readBlock(session, alignedStart, alignedEnd - alignedStart);
                if (alignedBytes.length !== alignedEnd - alignedStart)
                    throw new Error(`DAP could not read adjacent bytes before writing ${item.name}`);
                alignedBytes.set(item.bytes, address - alignedStart);
                const result = unwrapResponse(
                    await session.customRequest("writeMemory", {
                        memoryReference: `0x${alignedStart.toString(16)}`,
                        offset: 0,
                        data: Buffer.from(alignedBytes).toString("base64"),
                        allowPartial: false
                    })
                );
                if (Number.isFinite(result.bytesWritten) && result.bytesWritten !== alignedBytes.length) {
                    throw new Error(`DAP partially wrote ${item.name}`);
                }
            }
            if (epoch !== this.epoch || !this.canWrite)
                throw new Error("Target continued before DAP write verification");
            const after = await this.read(plan, session);
            if (epoch === this.epoch && this.paused) {
                this.snapshotReady = true;
                this.snapshotPending = false;
                this.onSamples(after, Date.now());
                this.onStatus(this.status());
            }
            return { before, after };
        } finally {
            this.writing = false;
        }
    }

    dispose() {
        this._invalidate();
        this.allSessions.clear();
        this.sessions.clear();
    }
}

module.exports = {
    DebugSessionBridge,
    MIN_DAP_INTERVAL_MS,
    SNAPSHOT_INITIAL_DELAY_MS,
    SNAPSHOT_RETRY_DELAYS_MS,
    mergeReadPlan,
    unwrapResponse
};

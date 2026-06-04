/**
 * #774 — round-trip test for the `queryLoopState` request/reply that
 * `cmds/inspect.ts` uses to pull the timer's live `ipcState` over
 * `loop.sock`. Stands up a real `createLoopServer` on a tmp UDS path,
 * mutates `ipcState`, opens an `openEventChannel`, requests, asserts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopServer } from "./state.js";
import { openEventChannel } from "./ipc-events.js";
import {
    resetIpcStateForTests,
    setIpcAfk,
    setIpcBootComplete,
    setIpcIdleSince,
    setIpcPaneBusy,
    setIpcPaneCompacting,
    setIpcPaneReady,
} from "./ipc-state.js";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test("queryLoopState: round-trips a populated ipcState snapshot", async () => {
    resetIpcStateForTests();
    const dir = mkdtempSync(join(tmpdir(), "loop-query-test-"));
    const sock = join(dir, "loop.sock");
    const server = createLoopServer(sock, { onProxyEvent: () => { /* unused */ } });
    try {
        setIpcPaneBusy(true);
        setIpcPaneReady(true);
        setIpcPaneCompacting(false);
        setIpcAfk("wait_10m", 1_700_000_000_000);
        setIpcBootComplete(true);
        setIpcIdleSince(1_699_999_990_000);

        await sleep(60); // let the server bind
        const ch = openEventChannel(sock, { reconnectMs: 50 });
        try {
            for (let i = 0; i < 40 && !ch.isConnected(); i++) await sleep(25);
            assert.ok(ch.isConnected(), "channel connected");
            const reply = await ch.request({ kind: "queryLoopState" }, 1000);
            assert.equal(reply.kind, "queryLoopStateReply");
            const d = reply.data as Record<string, unknown>;
            assert.equal(d.paneBusy, true);
            assert.equal(d.paneReady, true);
            assert.equal(d.paneCompacting, false);
            assert.equal(d.afkMode, "wait_10m");
            assert.equal(d.afkExpiryMs, 1_700_000_000_000);
            assert.equal(d.bootComplete, true);
            assert.equal(d.idleSinceMs, 1_699_999_990_000);
        } finally {
            ch.close();
        }
    } finally {
        server.close();
        resetIpcStateForTests();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test("queryLoopState: reflects ipcState reset (null mode, false panes)", async () => {
    resetIpcStateForTests();
    const dir = mkdtempSync(join(tmpdir(), "loop-query-reset-test-"));
    const sock = join(dir, "loop.sock");
    const server = createLoopServer(sock, { onProxyEvent: () => { /* unused */ } });
    try {
        await sleep(60);
        const ch = openEventChannel(sock, { reconnectMs: 50 });
        try {
            for (let i = 0; i < 40 && !ch.isConnected(); i++) await sleep(25);
            const reply = await ch.request({ kind: "queryLoopState" }, 1000);
            const d = reply.data as Record<string, unknown>;
            // Pane: `null ?? false`
            assert.equal(d.paneBusy, false);
            assert.equal(d.paneReady, false);
            assert.equal(d.paneCompacting, false);
            // Afk / typing / idle / boot stay raw null (the cli inspect
            // layer formats null itself).
            assert.equal(d.afkMode, null);
            assert.equal(d.afkExpiryMs, null);
            assert.equal(d.humanTypingAtMs, null);
            assert.equal(d.idleSinceMs, null);
            assert.equal(d.bootComplete, null);
        } finally {
            ch.close();
        }
    } finally {
        server.close();
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

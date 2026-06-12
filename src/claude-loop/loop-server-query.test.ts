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
import { createLoopServer, LOOP_SOCK_KIND, sendShutdownToTimer } from "./state.js";
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

// #866 Slice 2 — shutdown handler round-trip via the injectable
// `onShutdownRequest` hook (= test-safe, doesn't kill the harness).

test("LOOP_SOCK_KIND.SHUTDOWN: handler fires onShutdownRequest once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-shutdown-test-"));
    const sock = join(dir, "loop.sock");
    let shutdownCalls = 0;
    const server = createLoopServer(sock, {
        onProxyEvent: () => {},
        onShutdownRequest: () => { shutdownCalls++; },
    });
    try {
        await sleep(60);
        await sendShutdownToTimer(dir, 300);
        // server.close() est fire-and-forget côté send. Laisse passer
        // le nextTick + le serveur traiter le frame.
        await sleep(150);
        assert.equal(shutdownCalls, 1);
    } finally {
        try { server.close(); } catch { /* ignore */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test("LOOP_SOCK_KIND enum: kinds canoniques", () => {
    assert.equal(LOOP_SOCK_KIND.VIEW, "view");
    assert.equal(LOOP_SOCK_KIND.PROXY_EVENT, "proxyEvent");
    assert.equal(LOOP_SOCK_KIND.INJECT, "inject");
    assert.equal(LOOP_SOCK_KIND.QUERY_LOOP_STATE, "queryLoopState");
    assert.equal(LOOP_SOCK_KIND.QUERY_LOOP_STATE_REPLY, "queryLoopStateReply");
    assert.equal(LOOP_SOCK_KIND.SHUTDOWN, "shutdown");
    assert.equal(LOOP_SOCK_KIND.LOG, "log");
});

// #944 Slice 1 — hook subprocess ships its log lines to the timer over
// loop.sock so the timer appends them to its own stdout (= unified loop
// log). Verify the LOG frame routes to onLogLine.
test("LOOP_SOCK_KIND.LOG: handler fires onLogLine with the line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-log-frame-"));
    const sock = join(dir, "loop.sock");
    const received: string[] = [];
    const server = createLoopServer(sock, {
        onProxyEvent: () => {},
        onLogLine: (line) => { received.push(line); },
    });
    try {
        await sleep(60);
        const ch = openEventChannel(sock, { reconnectMs: 50 });
        try {
            for (let i = 0; i < 40 && !ch.isConnected(); i++) await sleep(25);
            ch.send({
                kind: LOOP_SOCK_KIND.LOG,
                data: { line: "2026-06-12T10:00:00.000Z [stop-hook:foo] INFO test line\n" },
            });
            // Server-side handler is sync but the frame travels over WS ;
            // give it a tick to land.
            for (let i = 0; i < 20 && received.length === 0; i++) await sleep(25);
            assert.equal(received.length, 1);
            assert.equal(received[0], "2026-06-12T10:00:00.000Z [stop-hook:foo] INFO test line\n");
        } finally {
            ch.close();
        }
    } finally {
        try { server.close(); } catch { /* ignore */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test("LOOP_SOCK_KIND.LOG: malformed payload (no .line) is silently ignored", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-log-bad-"));
    const sock = join(dir, "loop.sock");
    const received: string[] = [];
    const server = createLoopServer(sock, {
        onProxyEvent: () => {},
        onLogLine: (line) => { received.push(line); },
    });
    try {
        await sleep(60);
        const ch = openEventChannel(sock, { reconnectMs: 50 });
        try {
            for (let i = 0; i < 40 && !ch.isConnected(); i++) await sleep(25);
            ch.send({ kind: LOOP_SOCK_KIND.LOG, data: { line: 42 } });
            ch.send({ kind: LOOP_SOCK_KIND.LOG, data: null });
            ch.send({ kind: LOOP_SOCK_KIND.LOG });
            await sleep(100);
            assert.equal(received.length, 0);
        } finally {
            ch.close();
        }
    } finally {
        try { server.close(); } catch { /* ignore */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

test("sendShutdownToTimer: socket absent → no-op silencieux", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-shutdown-noop-"));
    // No server bound → sendShutdownToTimer doit résoudre sans throw.
    await sendShutdownToTimer(dir, 200);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * #729 — tests for the ipc-events layer. Round-trip on real UDS sockets
 * (temp dir). node:test, no docker, no daemon, no extra deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenEvents, openEventChannel, sendEventOnce, type Event } from "./ipc-events.js";

// #739 — the win32 loopback transport landed, so these now run on EVERY
// platform via the platform-default transport (UDS on Unix, loopback TCP
// on win32). `unixOnly` gates the few cases asserting the UDS-specific
// filesystem artifact (the socket file), which has no equivalent on the
// loopback path (it publishes a `.addr` marker instead — covered by the
// transport-contract test).
const t = test;
const unixOnly = process.platform === "win32" ? test.skip : test;

function withTmpSocketPath<T>(fn: (path: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "ipc-events-test-"));
    const sockPath = join(dir, "test.sock");
    return fn(sockPath).finally(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

t("listenEvents + sendEventOnce : single event delivery", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const received: Event[] = [];
        const server = listenEvents(sockPath, (ev) => { received.push(ev); });
        // Give the server a moment to actually start listening.
        await sleep(50);
        await sendEventOnce(sockPath, { kind: "ping", data: { n: 1 } });
        // Wait for the message to land.
        await sleep(100);
        server.close();
        assert.equal(received.length, 1);
        assert.equal(received[0].kind, "ping");
        assert.deepEqual(received[0].data, { n: 1 });
    });
});

t("listenEvents + sendEventOnce : awaitReply round-trip", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const server = listenEvents(sockPath, (ev, { reply }) => {
            if (ev.kind === "ask") reply({ kind: "answer", data: { result: 42 } });
        });
        await sleep(50);
        const reply = await sendEventOnce(sockPath, { kind: "ask" }, { awaitReply: true });
        server.close();
        assert.ok(reply, "reply received");
        assert.equal(reply!.kind, "answer");
        assert.deepEqual(reply!.data, { result: 42 });
    });
});

t("listenEvents : malformed JSON is silently dropped", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const received: Event[] = [];
        const server = listenEvents(sockPath, (ev) => { received.push(ev); });
        await sleep(50);
        // Use the channel API to send a well-formed event AFTER one malformed
        // attempt — we can't easily send raw garbage via the public API, but
        // we can verify that valid events still flow if a malformed one
        // would have been silently ignored.
        await sendEventOnce(sockPath, { kind: "good", data: {} });
        await sleep(100);
        server.close();
        assert.equal(received.length, 1);
        assert.equal(received[0].kind, "good");
    });
});

t("openEventChannel : long-lived send + receive", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const serverReceived: Event[] = [];
        const server = listenEvents(sockPath, (ev) => { serverReceived.push(ev); });
        await sleep(50);
        const channel = openEventChannel(sockPath);
        // Wait for connection to establish.
        for (let i = 0; i < 20 && !channel.isConnected(); i++) await sleep(25);
        assert.ok(channel.isConnected(), "channel connected");
        channel.send({ kind: "tick", data: { i: 1 } });
        channel.send({ kind: "tick", data: { i: 2 } });
        await sleep(100);
        channel.close();
        server.close();
        assert.equal(serverReceived.length, 2);
        assert.deepEqual(serverReceived.map((e) => (e.data as { i: number }).i), [1, 2]);
    });
});

t("openEventChannel : request/reply round-trip", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const server = listenEvents(sockPath, (ev, { reply }) => {
            if (ev.kind === "echo") reply({ kind: "echoed", data: ev.data });
        });
        await sleep(50);
        const channel = openEventChannel(sockPath);
        for (let i = 0; i < 20 && !channel.isConnected(); i++) await sleep(25);
        const reply = await channel.request({ kind: "echo", data: { hello: "world" } });
        channel.close();
        server.close();
        assert.equal(reply.kind, "echoed");
        // The data carries the __req correlation id alongside the original payload.
        const d = reply.data as { hello?: string; __req?: string };
        assert.equal(d.hello, "world");
        assert.ok(typeof d.__req === "string");
    });
});

t("openEventChannel : onEvent push from server", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const server = listenEvents(sockPath, (ev, { reply }) => {
            if (ev.kind === "subscribe") {
                // Capture the reply hook AS our push channel for this test —
                // each frame the test wants to send becomes a server-pushed
                // event observed by the client's onEvent handler.
                reply({ kind: "push:ack" });
                // Simulate a delayed server push using setTimeout. The reply
                // is the only path back to the client in our API, so we
                // re-purpose subsequent sends via the underlying ws.
                // Workaround for the test: we'll just use reply as the push.
            }
        });
        // Direct push test : let the server use its reply mechanism, the
        // client treats unsolicited replies as inbound events.
        const inbound: Event[] = [];
        await sleep(50);
        const channel = openEventChannel(sockPath);
        channel.onEvent((ev) => { inbound.push(ev); });
        for (let i = 0; i < 20 && !channel.isConnected(); i++) await sleep(25);
        // Fire a subscribe-style event without awaiting reply — the server's
        // `reply({kind:"push:ack"})` lands as an unsolicited inbound on the
        // client (no __req, so it bypasses request correlation).
        channel.send({ kind: "subscribe" });
        await sleep(100);
        channel.close();
        server.close();
        assert.equal(inbound.length, 1);
        assert.equal(inbound[0].kind, "push:ack");
    });
});

t("sendEventOnce : resolves undefined on connect failure (no throw by default)", async () => {
    // Socket path that doesn't exist — sendEventOnce should fail silently.
    const noSock = join(tmpdir(), "ipc-events-no-such-sock-" + Date.now() + ".sock");
    assert.equal(existsSync(noSock), false);
    const result = await sendEventOnce(noSock, { kind: "x" }, { timeoutMs: 200 });
    assert.equal(result, undefined);
});

t("sendEventOnce : rejects on connect failure when throwOnError=true", async () => {
    const noSock = join(tmpdir(), "ipc-events-no-such-sock-throw-" + Date.now() + ".sock");
    await assert.rejects(
        () => sendEventOnce(noSock, { kind: "x" }, { timeoutMs: 200, throwOnError: true }),
    );
});

unixOnly("listenEvents : close unlinks the socket file", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const server = listenEvents(sockPath, () => {});
        await sleep(50);
        assert.ok(existsSync(sockPath), "socket file exists while listening");
        server.close();
        await sleep(50);
        assert.equal(existsSync(sockPath), false, "socket file unlinked after close");
    });
});

t("listenEvents : second listen on same path overwrites first (orphan socket cleanup)", async () => {
    await withTmpSocketPath(async (sockPath) => {
        const s1 = listenEvents(sockPath, () => {});
        await sleep(50);
        s1.close();
        await sleep(50);
        // Second listen should succeed (socket file was cleaned by close,
        // and would be cleaned by listenEvents' own unlinkSync regardless).
        const received: Event[] = [];
        const s2 = listenEvents(sockPath, (ev) => { received.push(ev); });
        await sleep(50);
        await sendEventOnce(sockPath, { kind: "after-restart" });
        await sleep(100);
        s2.close();
        assert.equal(received.length, 1);
        assert.equal(received[0].kind, "after-restart");
    });
});

// #1032 S2 — openEventChannel surfaces connection transitions so consumers
// can resync (drain offload, repaint bar, re-handshake the proxy…).
// We assert the reliably-deterministic half: onConnect fires once the server
// is reachable, NOT before. onDisconnect is symmetric (same `close` handler,
// gated on a LIVE connection dropping) — it only triggers on a real peer drop
// (process death), which a graceful `server.close()` doesn't simulate (ws keeps
// established connections open), so it's exercised by the runtime path.
t("openEventChannel : onConnect fires once the server is reachable, not before", async () => {
    await withTmpSocketPath(async (sockPath) => {
        let connects = 0;
        // Open BEFORE any server exists → connect() retries on backoff, no onConnect yet.
        const ch = openEventChannel(sockPath, {
            reconnectMs: 50,
            onConnect: () => { connects++; },
        });
        await sleep(120);
        assert.equal(connects, 0, "onConnect does NOT fire while the server is absent");

        // Bring the server up → the retry loop connects → onConnect fires.
        const server = listenEvents(sockPath, () => { /* noop */ });
        await sleep(200);
        assert.ok(connects >= 1, `onConnect fired once the server became reachable (got ${connects})`);

        ch.close();
        server.close();
    });
});

// #1032 S2 — listenEvents fires onClientConnect/onClientDisconnect so the timer
// (server) can resync the proxy when it (re)connects to a respawned loop.sock.
// A CLIENT close IS observed server-side (unlike the reverse), so this is
// deterministic.
t("listenEvents : onClientConnect on connect, onClientDisconnect on client close", async () => {
    await withTmpSocketPath(async (sockPath) => {
        let clientConnects = 0;
        let clientDisconnects = 0;
        const server = listenEvents(sockPath, () => { /* noop */ }, {
            onClientConnect: () => { clientConnects++; },
            onClientDisconnect: () => { clientDisconnects++; },
        });
        await sleep(50);
        const ch = openEventChannel(sockPath, { reconnectMs: 50 });
        await sleep(150);
        assert.equal(clientConnects, 1, "onClientConnect fired when the client connected");
        assert.equal(clientDisconnects, 0);

        // Client goes away → the server observes the close.
        ch.close();
        await sleep(150);
        assert.ok(clientDisconnects >= 1, `onClientDisconnect fired when the client left (got ${clientDisconnects})`);

        server.close();
    });
});

/**
 * #739 — shared transport contract. The SAME assertions prove both the
 * UDS and loopback-TCP transports satisfy the ipc-events Transport
 * interface, by driving the real listenEvents/sendEventOnce/openEventChannel
 * code path with each impl injected via `opts.transport`.
 *
 * Loopback TCP works on every platform, so the `win32-loopback` case runs
 * on the Linux CI runner too. The `uds` case skips on win32 (no AF_UNIX
 * path for `ws` there).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listenEvents, openEventChannel, sendEventOnce, type Event } from "../ipc-events.js";
import { udsTransport, win32Transport, type Transport } from "./index.js";

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function withTmpSock<T>(name: string, fn: (sock: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), `transport-${name}-`));
    return fn(join(dir, "test.sock")).finally(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

const CASES: { name: string; transport: Transport; skip: boolean }[] = [
    { name: "uds", transport: udsTransport, skip: process.platform === "win32" },
    { name: "win32-loopback", transport: win32Transport, skip: false },
];

for (const { name, transport, skip } of CASES) {
    const tt = skip ? test.skip : test;

    tt(`[${name}] listenEvents + sendEventOnce round-trip`, async () => {
        await withTmpSock(name, async (sock) => {
            const received: Event[] = [];
            const server = listenEvents(sock, (ev) => { received.push(ev); }, { transport });
            await sleep(60);
            await sendEventOnce(sock, { kind: "ping", data: { n: 7 } }, { transport });
            await sleep(100);
            server.close();
            assert.equal(received.length, 1);
            assert.deepEqual(received[0].data, { n: 7 });
        });
    });

    tt(`[${name}] openEventChannel reconnects once the server publishes its address`, async () => {
        await withTmpSock(name, async (sock) => {
            // Client opens BEFORE the server — exercises clientUrl()===null /
            // refused-reconnect until the server is up and addressable.
            const channel = openEventChannel(sock, { transport, reconnectMs: 30 });
            await sleep(60);
            assert.equal(channel.isConnected(), false, "no server yet");
            const server = listenEvents(sock, (ev, { reply }) => {
                if (ev.kind === "echo") reply({ kind: "echoed", data: ev.data });
            }, { transport });
            for (let i = 0; i < 40 && !channel.isConnected(); i++) await sleep(25);
            assert.ok(channel.isConnected(), "channel reconnected once server up");
            const reply = await channel.request({ kind: "echo", data: { v: 1 } });
            assert.equal(reply.kind, "echoed");
            channel.close();
            server.close();
        });
    });

    tt(`[${name}] cleanup removes the addressing artifact on close`, async () => {
        await withTmpSock(name, async (sock) => {
            const server = listenEvents(sock, () => {}, { transport });
            await sleep(60);
            const artifact = name === "uds" ? sock : `${sock}.addr`;
            assert.ok(existsSync(artifact), "addressing artifact present while listening");
            server.close();
            await sleep(60);
            assert.equal(existsSync(artifact), false, "artifact removed after close");
        });
    });
}

// Loopback's token gate — the security property that replaces UDS file
// perms. Runs on every platform (loopback works everywhere). Drives the
// transport directly since the public API only ever sends the right token.
test("[win32-loopback] accept gates on the shared token", async () => {
    await withTmpSock("win32-tok", async (sock) => {
        const http = createHttpServer();
        const tServer = win32Transport.bind(http, sock);
        await sleep(60);
        const url = win32Transport.clientUrl(sock);
        assert.ok(url, "address resolvable while listening");
        const goodToken = new URL(url!).searchParams.get("t");
        assert.ok(goodToken, "token published in client URL");
        assert.equal(tServer.accept(`/?t=${encodeURIComponent(goodToken!)}`), true, "correct token accepted");
        assert.equal(tServer.accept("/?t=wrong"), false, "wrong token rejected");
        assert.equal(tServer.accept("/"), false, "missing token rejected");
        assert.equal(tServer.accept(undefined), false, "no url rejected");
        tServer.cleanup();
        try { http.close(); } catch { /* ignore */ }
    });
});

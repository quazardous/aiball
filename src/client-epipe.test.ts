/**
 * #2462 — `ticket_claim` failed three times with a bare `write EPIPE`. That
 * exact text comes from a server that closes the connection before reading the
 * request (reproduced below on a throwaway socket). The request never reached a
 * handler, so a replay is safe; it was not replayed, and the error named
 * neither the call nor the socket. What must hold, over a real Unix socket:
 * - a connection dropped before the request is read is retried, and the
 *   request then runs exactly once;
 * - when it never gets through, the error keeps its code and names the call
 *   and the transport.
 * #3067 — the client calls the core over the bus: the server below is a bus.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { AiballClient } from "./client.js";

const DIR = mkdtempSync(join(tmpdir(), "aiball-2462-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A bus that drops the first `dropFirst` connections on accept, then serves. */
async function flakyServer(name: string, dropFirst: number): Promise<{ sock: string; server: Server; handled: string[] }> {
    const sock = join(DIR, `${name}.sock`);
    const handled: string[] = [];
    const server = createServer();
    const bus = new WebSocketServer({ server, path: "/bus" });
    bus.on("connection", (ws) => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "bus.hello", params: { version: 1, epoch: "e", consumer: "me", kind: "agent", relayed: false } }));
        ws.on("message", (d) => {
            const call = JSON.parse(String(d)) as { id: number; method: string };
            handled.push(call.method);
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: { ticket_id: 7, claimant: "me", is_claim: true } }));
        });
    });
    // Closing the server waits for its connections: the bus's go first.
    const close = server.close.bind(server);
    server.close = ((cb?: (e?: Error) => void) => { for (const ws of bus.clients) ws.terminate(); return close(cb); }) as typeof server.close;
    let seen = 0;
    server.on("connection", (s) => {
        if (seen++ < dropFirst) s.destroy();
    });
    await new Promise<void>((r) => server.listen(sock, () => r()));
    return { sock, server, handled };
}

test("a connection dropped before the request is read is retried, and the claim runs once", async () => {
    const { sock, server, handled } = await flakyServer("flaky", 2);
    try {
        const r = await new AiballClient({ socketPath: sock, agentId: "me" }).assignTicket(7);
        assert.equal(r.claimant, "me");
        assert.deepEqual(handled, ["ticket.assign"], "handled exactly once");
    } finally {
        server.close();
    }
});

test("when it never gets through, the error keeps EPIPE and names the call and the socket", async () => {
    const { sock, server, handled } = await flakyServer("dead", Number.POSITIVE_INFINITY);
    try {
        await assert.rejects(
            new AiballClient({ socketPath: sock, agentId: "me" }).assignTicket(7),
            (e: Error & { code?: string }) => {
                assert.equal(e.code, "EPIPE");
                assert.match(e.message, new RegExp(`^bus ticket.assign via unix:${sock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: write EPIPE$`));
                return true;
            },
        );
        assert.deepEqual(handled, []);
    } finally {
        server.close();
    }
});

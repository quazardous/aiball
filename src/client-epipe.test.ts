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
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiballClient } from "./client.js";

const DIR = mkdtempSync(join(tmpdir(), "aiball-2462-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

/** A server that drops the first `dropFirst` connections on accept, then serves. */
async function flakyServer(name: string, dropFirst: number): Promise<{ sock: string; server: Server; handled: string[] }> {
    const sock = join(DIR, `${name}.sock`);
    const handled: string[] = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            handled.push(`${req.method} ${req.url}`);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ticket_id: 7, claimant: "me", is_claim: true }));
        });
    });
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
        assert.deepEqual(handled, ["POST /api/tickets/7/assign"], "handled exactly once");
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
                assert.match(e.message, new RegExp(`^POST /api/tickets/7/assign via unix:${sock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: write EPIPE$`));
                return true;
            },
        );
        assert.deepEqual(handled, []);
    } finally {
        server.close();
    }
});

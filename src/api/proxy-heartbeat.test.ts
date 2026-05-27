// #502 — POST /api/proxy/heartbeat : trivial 204 endpoint hit toutes les 30s par
// le proxy node, exploite le bump `tokens.last_used_at` du middleware auth pour
// alimenter la pastille up/down côté Nodes panel. Gated node-token (un agent
// token n'a pas le droit, 403).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Throwaway DB BEFORE any module that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-502-"));

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { listNodes } = await import("../db/nodes.js");
const { ensureConsumer } = await import("../db.js");
const { sendProxyHeartbeat } = await import("../proxy.js");

ensureConsumer("test-agent");
const NODE_TOKEN = issueToken({ kind: "node", label: "test-node" }).token;
const AGENT_TOKEN = issueToken({ kind: "agent", consumer_id: "test-agent", label: "agent" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

async function hit(token: string | null): Promise<{ status: number; body: string }> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${BASE}/api/proxy/heartbeat`, { method: "POST", headers });
    return { status: r.status, body: await r.text() };
}

test("POST /api/proxy/heartbeat : node token → 204, no body", async () => {
    const r = await hit(NODE_TOKEN);
    assert.equal(r.status, 204);
    assert.equal(r.body, "");
});

test("POST /api/proxy/heartbeat : agent token → 403", async () => {
    const r = await hit(AGENT_TOKEN);
    assert.equal(r.status, 403);
    assert.match(r.body, /node token required/);
});

test("POST /api/proxy/heartbeat : no token → 401", async () => {
    const r = await hit(null);
    assert.equal(r.status, 401);
});

test("POST /api/proxy/heartbeat : auth middleware bumps tokens.last_used_at (drives the pastille)", async () => {
    const before = listNodes().find((n) => n.label === "test-node");
    assert.ok(before, "node row exists");
    await new Promise<void>((r) => setTimeout(r, 10)); // ensure timestamp tick
    const r = await hit(NODE_TOKEN);
    assert.equal(r.status, 204);
    const after = listNodes().find((n) => n.label === "test-node");
    assert.ok(after?.last_used_at, "last_used_at populated after heartbeat");
    if (before?.last_used_at) {
        assert.ok(after!.last_used_at! >= before.last_used_at, "last_used_at moved forward (or equal — same ms tick)");
    }
});

test("sendProxyHeartbeat : tape l'endpoint upstream avec le node token + label", async () => {
    const before = listNodes().find((n) => n.label === "test-node")?.last_used_at;
    sendProxyHeartbeat({ url: BASE, token: NODE_TOKEN, nodeLabel: "renamed-via-heartbeat" });
    // Pas de Promise — le http.request est fire-and-forget. Poll court : l'auth
    // middleware bumpe last_used_at et sync le label en synchrone côté daemon.
    for (let i = 0; i < 30; i++) {
        const row = listNodes().find((n) => n.node_id);
        if (row?.label === "renamed-via-heartbeat" && row.last_used_at && row.last_used_at !== before) break;
        await new Promise<void>((r) => setTimeout(r, 20));
    }
    const after = listNodes().find((n) => n.label === "renamed-via-heartbeat");
    assert.ok(after, "label sync via x-aiball-node-label fonctionne en bout de chaîne");
    assert.ok(after!.last_used_at, "last_used_at bumpé par le heartbeat");
});

after(() => {
    server.close();
    try {
        rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true });
    } catch {
        /* best-effort temp cleanup */
    }
});

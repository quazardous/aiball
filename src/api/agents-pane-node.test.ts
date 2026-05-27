// #503 — quand un consumer est node-relayé (last_seen_via='node'), le pane
// vit sur un autre host : le daemon local ne peut pas faire `tmux capture-pane`.
// On dégrade proprement : SSE → 1 event `unavailable` + close ; POST keys → 501.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-503-"));

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { ensureConsumer, touchLastSeen } = await import("../db.js");

ensureConsumer("graphite-loop");
// Marquer le consumer comme node-relayé (ce que fait l'auth middleware sur la
// branche node-token).
touchLastSeen("graphite-loop", "node", "10.0.0.42");
ensureConsumer("operator");
const TOKEN = issueToken({ kind: "agent", consumer_id: "operator", label: "ops" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

test("GET /pane/stream : node-relayed consumer → SSE 'unavailable' event puis close", async () => {
    const r = await fetch(
        `${BASE}/api/agents/graphite-loop/pane/stream`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /event: unavailable/);
    assert.match(text, /node-relayed agents/);
    assert.match(text, /"last_seen_via":"node"/);
});

test("POST /pane/keys : node-relayed consumer → 501 + message clair", async () => {
    const r = await fetch(
        `${BASE}/api/agents/graphite-loop/pane/keys`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ keys: "ls\n" }),
        },
    );
    assert.equal(r.status, 501);
    const body = await r.json() as { error: string; last_seen_via: string };
    assert.match(body.error, /not available for node-relayed agents/);
    assert.equal(body.last_seen_via, "node");
});

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});

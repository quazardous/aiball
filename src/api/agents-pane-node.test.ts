// #505 phase 2 — quand un consumer est node-relayé MAIS qu'aucun node n'est
// connecté en WS (le proxy daemon est down ou pas encore upgradé), on dégrade :
//  - SSE → 200 + 1 frame `event: unavailable` + close.
//  - POST keys → 503 + message clair.
//
// Le cas où le node EST connecté (la WS route bien) est couvert par
// `proxy-ws-pane.test.ts` (avec un fake-node).
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
// branche node-token). Aucun fake-node connecté → pas de WS → dégradation.
touchLastSeen("graphite-loop", "node", "10.0.0.42");
ensureConsumer("operator");
const TOKEN = issueToken({ kind: "agent", consumer_id: "operator", label: "ops" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

test("GET /pane/stream : node-relayed mais node hors-ligne → event 'unavailable'", async () => {
    const r = await fetch(
        `${BASE}/api/agents/graphite-loop/pane/stream`,
        { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await r.text();
    assert.match(text, /event: unavailable/);
    assert.match(text, /not currently connected/);
});

test("POST /pane/keys : node-relayed mais node hors-ligne → 503 + message", async () => {
    const r = await fetch(
        `${BASE}/api/agents/graphite-loop/pane/keys`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ keys: "ls\n" }),
        },
    );
    assert.equal(r.status, 503);
    const body = await r.json() as { error: string };
    assert.match(body.error, /not currently connected/);
});

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true }); } catch { /* */ }
});

/**
 * #1477 — a consumer's capability fields (can_claim; future can_create_agent)
 * are human-piloted. PATCH /consumers/:id must reject an agent touching a
 * capability field (else the whole #1435 authority model + #508 no-claim
 * specialists are decorative), while still letting agents edit non-capability
 * fields and letting a human set capabilities. Spawns the real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1477-"));

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, ensureConsumer, getConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
ensureConsumer("target");
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "1477-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "1477-a" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function patch(token: string, body: unknown): Promise<Response> {
    return fetch(`${BASE}/api/consumers/target`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("agent editing can_claim → 403 (capability is human-only), flag unchanged", async () => {
    assert.equal(getConsumer("target")?.can_claim, true); // default
    const res = await patch(AGENT, { can_claim: false });
    assert.equal(res.status, 403);
    assert.equal(getConsumer("target")?.can_claim, true); // still the default — not flipped
});

test("human editing can_claim → 200", async () => {
    const res = await patch(HUMAN, { can_claim: false });
    assert.equal(res.status, 200);
    assert.equal(getConsumer("target")?.can_claim, false);
});

test("agent editing a NON-capability field (note) → still allowed", async () => {
    const res = await patch(AGENT, { note: "hello from agent" });
    assert.equal(res.status, 200);
    assert.equal(getConsumer("target")?.note, "hello from agent");
});

test("agent editing can_create_agent → 403 (capability is human-only)", async () => {
    assert.equal(getConsumer("target")?.can_create_agent, false); // default
    const res = await patch(AGENT, { can_create_agent: true });
    assert.equal(res.status, 403);
    assert.equal(getConsumer("target")?.can_create_agent, false); // not granted
});

test("human granting can_create_agent → 200", async () => {
    const res = await patch(HUMAN, { can_create_agent: true });
    assert.equal(res.status, 200);
    assert.equal(getConsumer("target")?.can_create_agent, true);
});

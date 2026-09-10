/**
 * #2201 — `agent_type` on the consumer record decides which MCP tools the agent
 * is shown, so it is human-set only, like can_claim: an agent must not be able
 * to pick its own tools. Spawns the real app on an ephemeral port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2201api-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, ensureConsumer, getConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
ensureConsumer("target");
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2201-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2201-a" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const patch = (token: string, body: unknown) => fetch(`${BASE}/api/consumers/target`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
});

test("a consumer nobody configured is the default type", () => {
    assert.equal(getConsumer("target")?.agent_type, "coder");
});

test("an agent cannot set an agent type: 403, and the type is unchanged", async () => {
    const res = await patch(AGENT, { agent_type: "cto" });
    assert.equal(res.status, 403);
    assert.equal(getConsumer("target")?.agent_type, "coder");
});

test("a human sets it, and it reads back on the record", async () => {
    const res = await patch(HUMAN, { agent_type: "cto" });
    assert.equal(res.status, 200);
    assert.equal(getConsumer("target")?.agent_type, "cto");
    const read = await fetch(`${BASE}/api/consumers/target`, { headers: { authorization: `Bearer ${AGENT}` } });
    assert.equal(((await read.json()) as { agent_type?: string }).agent_type, "cto");
});

test("an unknown type is refused, not stored", async () => {
    const res = await patch(HUMAN, { agent_type: "boss" });
    assert.equal(res.status, 400);
    assert.equal(getConsumer("target")?.agent_type, "cto");
});

test("setting it back to coder restores the default", async () => {
    assert.equal((await patch(HUMAN, { agent_type: "coder" })).status, 200);
    assert.equal(getConsumer("target")?.agent_type, "coder");
});

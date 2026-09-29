/**
 * #2201 — `agent_type` on the consumer record decides which MCP tools the agent
 * is shown, so it is human-set only, like can_claim: an agent must not be able
 * to pick its own tools. Over the bus, as a client holding a token calls it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2201api-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, ensureConsumer, getConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
ensureConsumer("target");
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2201-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2201-a" }).token;

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const patch = (token: string, body: Record<string, unknown>) => asToken(token, "consumer.update", { consumer_id: "target", ...body });

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
    const read = await asToken<{ agent_type?: string }>(AGENT, "consumer.get", { consumer_id: "target" });
    assert.equal(read.json.agent_type, "cto");
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

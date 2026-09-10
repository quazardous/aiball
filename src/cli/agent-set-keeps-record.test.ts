/**
 * #2180 — typing an agent must not damage its record. POST /api/consumers
 * resets every field it is not sent, so an early version of `agent set` /
 * `start --type` would have wiped an existing agent's display name and note and
 * re-enabled it if disabled — reproduced on a throwaway app before the fix.
 * This pins the real path: a real client against the real app.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2180keep-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { updateConsumer } = await import("../db/consumers.js");
const { AiballClient } = await import("../client.js");
const { applyAgentType } = await import("../claude-loop/agent-type.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent", display_name: "Nice name", note: "keep me" });
updateConsumer("agent-x", { enabled: false });
const TOKEN = issueToken({ kind: "agent", consumer_id: "boss", label: "2180keep" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const human = () => new AiballClient({ url: BASE, agentId: "boss", token: TOKEN });

test("typing an existing agent changes its type and nothing else", async () => {
    const v = await applyAgentType({ agentId: "agent-x", type: "cto", human: human() });
    assert.deepEqual(v, { ok: true });
    const c = getConsumer("agent-x");
    assert.equal(c?.agent_type, "cto");
    assert.equal(c?.display_name, "Nice name", "display name kept");
    assert.equal(c?.note, "keep me", "note kept");
    assert.equal(c?.enabled, false, "a disabled agent stays disabled");
});

test("typing an agent that has no record yet creates it with that type", async () => {
    const v = await applyAgentType({ agentId: "brand-new", type: "cto", human: human() });
    assert.deepEqual(v, { ok: true });
    assert.equal(getConsumer("brand-new")?.agent_type, "cto");
});

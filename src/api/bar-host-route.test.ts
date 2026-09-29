/**
 * #3044 — `consumer.set_bar_host`, over the bus: a loop control, like AFK. A
 * moderator's, never an agent's; the host must be tmux or external; an agent
 * without a local loop is a 404 LOOP_NOT_FOUND. Relayed to the loop's kernel,
 * which records it in the loop's state file.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3044-api-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3044-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3044-w" }).token;

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function post(token: string, body: Record<string, unknown>): Promise<{ status: number; code: unknown }> {
    const r = await asToken<{ code?: unknown }>(token, "consumer.set_bar_host", { consumer_id: "worker", ...body });
    return { status: r.status, code: r.json?.code };
}

test("an agent may not switch it; a moderator must name tmux or external; no local loop is a 404", async () => {
    assert.deepEqual(await post(WORKER, { host: "external" }), { status: 403, code: "MODERATOR_ONLY" });
    assert.deepEqual(await post(HUMAN, { host: "web" }), { status: 400, code: "BAD_REQUEST" });
    assert.deepEqual(await post(HUMAN, { host: "external" }), { status: 404, code: "LOOP_NOT_FOUND" }, "worker has no loop heartbeat");
});

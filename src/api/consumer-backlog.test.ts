/**
 * #3031 — a given agent's backlog, read by a moderator without impersonation:
 * - it is what the agent's own backlog call returns, row for row;
 * - another agent may not read it; an unknown agent is a 404;
 * - reading it has no side effect: no ping is marked seen, no wake recorded.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3031-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-3031";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3031-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3031-w" }).token;
const OTHER = issueToken({ kind: "agent", consumer_id: "other", label: "3031-o" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

// A few tickets of different shapes, so the backlog has tiers to tell apart.
for (const title of ["one", "two", "three"]) submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" });
const mine = submitMessage({ project: P, kind: "ticket_created", title: "the worker's own", body: "x", by_agent: "worker" }).id;
submitMessage({ project: P, kind: "comment_added", ticket_id: mine, body: "a reply", by_agent: "boss" });

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function get(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: unknown }> {
    return asToken(token, method, params);
}
const Q = { project: P, cooldown_sec: 3600, limit: 500 };

test("the moderator reads the backlog the agent itself gets", async () => {
    const own = await get(WORKER, "ticket.list", { backlog: true, ...Q });
    const watched = await get(HUMAN, "consumer.backlog", { consumer_id: "worker", ...Q });
    assert.equal(watched.status, 200);
    const body = watched.json as { consumer_id: string; rows: unknown[]; unread: number };
    assert.equal(body.consumer_id, "worker");
    assert.ok(body.rows.length > 0, "the backlog has rows");
    assert.deepEqual(body.rows, own.json, "row for row what the agent's own call returns");
    assert.equal(typeof body.unread, "number");
    // And not the moderator's own view of the same list.
    const moderators = await get(HUMAN, "ticket.list", { backlog: true, ...Q });
    assert.notDeepEqual(body.rows, moderators.json, "computed for the agent, not the caller");
});

test("another agent may not read it; an unknown agent is a 404; the agent reads its own", async () => {
    assert.equal((await get(OTHER, "consumer.backlog", { consumer_id: "worker", ...Q })).status, 403);
    assert.equal((await get(HUMAN, "consumer.backlog", { consumer_id: "nobody", ...Q })).status, 404);
    assert.equal((await get(WORKER, "consumer.backlog", { consumer_id: "worker", ...Q })).status, 200);
});

test("reading it marks nothing seen and records no wake", async () => {
    const db = getDb();
    const seen = () => db.select().from(schema.pings).all().filter((p) => p.seenAt !== null).length;
    const wakes = () => db.select().from(schema.backlogWakeLog).all().length;
    const before = { seen: seen(), wakes: wakes() };
    await get(HUMAN, "consumer.backlog", { consumer_id: "worker", ...Q });
    await get(HUMAN, "consumer.backlog", { consumer_id: "worker", ...Q });
    assert.deepEqual({ seen: seen(), wakes: wakes() }, before);
});

/**
 * #2388 david — what a relation to a ticket that is not (or no longer) approved
 * does. A blocker only gates while the board can act on it, and the three edge
 * states were neither covered nor announced. What must hold, over the real routes:
 * - a blocker still awaiting moderation gates nothing: the dependent is its
 *   agent's, and nothing is posted;
 * - a rejected blocker gates nothing either, but the tickets that were waiting
 *   on it hear it once (`dependency_rejected`) instead of losing their gate in
 *   silence — and a ticket merely linked to it hears nothing;
 * - a SNOOZED blocker keeps gating (david): asleep is not done, so the
 *   dependent stays blocked until the snooze runs out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2388-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2388";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2388-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2388-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
/** An approved ticket, filed by the human. */
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
/** A ticket still awaiting the moderator: the agent files it. */
function pendingTicket(title: string): number {
    const m = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "worker" });
    assert.equal(m.status, "pending", "precondition: an agent's ticket waits for the moderator");
    return m.id;
}
async function relate(source: number, target: number, kind: string): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${source}/relations`, { target_ticket_id: target, kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}
async function row(ticketId: number): Promise<{ actionable: boolean; backlog_tier: number | null }> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${P}&backlog=1&limit=500`);
    const rows = r.json as { id: number; actionable: boolean; backlog_tier: number | null }[];
    const found = rows.find((x) => x.id === ticketId);
    assert.ok(found, `#${ticketId} in the worker's backlog`);
    return found!;
}
function relationEvents(onTicket: number): string[] {
    return getDb().select({ kind: schema.messages.kind })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, onTicket))
        .all()
        .map((r) => r.kind)
        .filter((k) => k === "dependency_closed" || k === "related_closed" || k === "dependency_rejected");
}

test("a blocker still awaiting moderation gates nothing, and says nothing", async () => {
    const blocker = pendingTicket("filed, never moderated");
    const waiting = ticket("waits on a ticket nobody approved");
    await relate(waiting, blocker, "depends_on");

    const r = await row(waiting);
    assert.equal(r.actionable, true, "the dependent is its agent's");
    assert.notEqual(r.backlog_tier, 4, "and not blocked");
    assert.deepEqual(relationEvents(waiting), []);
});

test("a rejected blocker gates nothing, but the ticket that waited on it hears it", async () => {
    const blocker = pendingTicket("filed, then rejected");
    const waiting = ticket("waits on the ticket that gets rejected");
    const linked = ticket("merely linked to the rejected ticket");
    await relate(waiting, blocker, "depends_on");
    await relate(linked, blocker, "relates_to");

    const rejected = await call(HUMAN, "POST", `/api/messages/${blocker}/reject`, {});
    assert.equal(rejected.status, 200, JSON.stringify(rejected.json));

    assert.deepEqual(relationEvents(waiting), ["dependency_rejected"], "said once, on the ticket that waited");
    assert.deepEqual(relationEvents(linked), [], "a link to it is not a wait on it");
    const r = await row(waiting);
    assert.equal(r.actionable, true, "the gate is gone — the ticket is the agent's again");
});

test("a snoozed blocker keeps gating: asleep is not done", async () => {
    const blocker = ticket("open, then snoozed");
    const waiting = ticket("waits on the snoozed ticket");
    await relate(waiting, blocker, "depends_on");
    assert.equal((await row(waiting)).backlog_tier, 4, "precondition: blocked while the blocker is open");

    const until = new Date(Date.now() + 3600_000).toISOString();
    const snoozed = await call(HUMAN, "POST", `/api/tickets/${blocker}/postpone`, { until });
    assert.equal(snoozed.status, 200, JSON.stringify(snoozed.json));

    const r = await row(waiting);
    assert.equal(r.backlog_tier, 4, "still blocked while its blocker sleeps");
    assert.equal(r.actionable, false);
});

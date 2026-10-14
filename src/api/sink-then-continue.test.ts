/**
 * #2365 then #4052 — a step's ticket and the backlog cooldown. #2365 sank a
 * step's ticket 5 minutes only after a wake; since a step says when it resumes
 * (`resume_on`), that window only re-woke stale steps the agent answered with
 * silence, every 5 minutes, forever (#4052: 37 backlog wakes in 33 minutes).
 * What must hold, over the bus:
 * - a wake the agent leaves unanswered cools a step's ticket for the whole
 *   cooldown, like a comment's;
 * - a step the agent posts after the wake lifts the cooldown at once.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2365-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { invalidateFlagsCache } = await import("../db/projects.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

const COOLDOWN = 3600;
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2365-w" }).token;
createProject({ name: "p-2365" });
upsertSubscription("worker", "p-2365", "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    return asToken<Record<string, unknown>>(WORKER, method, params);
}

async function held(project: string, title: string): Promise<number> {
    const id = submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
    const r = await call("ticket.assign", { id });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return id;
}
async function post(project: string, ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await call("message.post", { project, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function wake(ticketId: number): Promise<void> {
    const r = await call("backlog.record_wake", { consumer_id: "worker", ticket_id: ticketId });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
/** Seconds the ticket stays cooled from now (0 = a wake candidate). */
async function cooledFor(project: string, ticketId: number): Promise<number> {
    const r = await asToken<{ id: number; backlog_cooled_until: string | null }[]>(WORKER, "ticket.list", { project, backlog: true, limit: 500, cooldown_sec: COOLDOWN });
    const rows = r.json;
    const row = rows.find((x) => x.id === ticketId);
    assert.ok(row, `#${ticketId} in the worker's backlog`);
    return row!.backlog_cooled_until ? Math.round((Date.parse(row!.backlog_cooled_until) - Date.now()) / 1000) : 0;
}
/** Move a ticket's last action and its wake into the past, keeping their order. */
function backdate(ticketId: number, messageId: number, actionAgoSec: number, wakeAgoSec: number): void {
    const now = Date.now();
    // One instant per value: the step is matched to the ticket by an EXACT
    // last_actor_at, so two clock reads a millisecond apart would unlink them.
    const actionAt = new Date(now - actionAgoSec * 1000).toISOString();
    const wakeAt = new Date(now - wakeAgoSec * 1000).toISOString();
    const db = getDb();
    db.update(schema.messages).set({ createdAt: actionAt }).where(eq(schema.messages.id, messageId)).run();
    db.update(schema.tickets).set({ lastActorAt: actionAt }).where(eq(schema.tickets.id, ticketId)).run();
    db.update(schema.backlogWakeLog).set({ wakeAt })
        .where(and(eq(schema.backlogWakeLog.consumerId, "worker"), eq(schema.backlogWakeLog.ticketId, ticketId))).run();
    // These writes skip the routes, so they skip the flags cache repair too.
    invalidateFlagsCache();
}

test("an unanswered wake cools a step's ticket for the whole cooldown, like a comment's", async () => {
    const stepped = await held("p-2365", "a step, then a wake");
    await post("p-2365", stepped, { step: true, step_after_minutes: 0 });
    await wake(stepped);
    const step = await cooledFor("p-2365", stepped);
    assert.ok(step > 300 && step <= COOLDOWN, `cooled for ${step}s, expected the whole cooldown`);

    const commented = await held("p-2365", "a question, then a wake");
    await post("p-2365", commented, { handback: true });
    await wake(commented);
    const comment = await cooledFor("p-2365", commented);
    assert.ok(comment > 300 && comment <= COOLDOWN, `cooled for ${comment}s, expected the whole cooldown`);
});

test("past 5 minutes a stale step's ticket is still cooled (#4052: it came back every 5 minutes)", async () => {
    const stepped = await held("p-2365", "stepped a while ago");
    const stepId = await post("p-2365", stepped, { step: true, step_after_minutes: 0 });
    await wake(stepped);
    backdate(stepped, stepId, 7 * 60, 6 * 60);
    assert.ok(await cooledFor("p-2365", stepped) > 0, "a silent answer to the wake keeps it resting");
});

test("a step posted after the wake lifts the cooldown at once", async () => {
    const stepped = await held("p-2365", "woken, then stepped");
    const first = await post("p-2365", stepped, { step: true, step_after_minutes: 0 });
    await wake(stepped);
    backdate(stepped, first, 7 * 60, 6 * 60);
    await post("p-2365", stepped, { step: true, step_after_minutes: 0 });
    assert.equal(await cooledFor("p-2365", stepped), 0);
});

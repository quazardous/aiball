/**
 * #2365 — the backlog wake that follows a step (`then: continue`) sinks the
 * ticket only briefly. It used to sink it for the whole cooldown, hiding the
 * work the step announced (seen live: a loop showing b:0 with six actionable
 * tickets). What must hold, over the real routes:
 * - a wake after a step cools the ticket for `tickets.sink_then_continue_minutes`
 *   (5 by default), a wake after any other last action for the whole cooldown;
 * - once that short window has passed the step's ticket is a candidate again,
 *   while a ticket whose last action is a comment is still cooled;
 * - 0 minutes never sinks a step's ticket.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2365-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setConfigOverride } = await import("../db/config-overrides.js");
const { invalidateFlagsCache } = await import("../db/projects.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

const COOLDOWN = 3600;
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2365-w" }).token;
for (const p of ["p-2365", "p-2365-zero"]) {
    createProject({ name: p });
    upsertSubscription("worker", p, "owner");
}
setConfigOverride("p-2365-zero", "tickets.sink_then_continue_minutes", 0);

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${WORKER}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function held(project: string, title: string): Promise<number> {
    const id = submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
    const r = await call("POST", `/api/tickets/${id}/assign`, {});
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return id;
}
async function post(project: string, ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await call("POST", "/api/messages", { project, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function wake(ticketId: number): Promise<void> {
    const r = await call("POST", "/api/backlog-wake", { consumer_id: "worker", ticket_id: ticketId });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
/** Seconds the ticket stays cooled from now (0 = a wake candidate). */
async function cooledFor(project: string, ticketId: number): Promise<number> {
    const r = await fetch(`${BASE}/api/tickets?project=${project}&backlog=1&limit=500&cooldown_sec=${COOLDOWN}`, { headers: { authorization: `Bearer ${WORKER}` } });
    const rows = await r.json() as { id: number; backlog_cooled_until: string | null }[];
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

test("a wake after a step cools the ticket for 5 minutes; after a comment, for the whole cooldown", async () => {
    const stepped = await held("p-2365", "a step, then a wake");
    await post("p-2365", stepped, { step: true });
    await wake(stepped);
    const step = await cooledFor("p-2365", stepped);
    assert.ok(step > 0 && step <= 300, `cooled for ${step}s, expected at most 5 minutes`);

    const commented = await held("p-2365", "a question, then a wake");
    await post("p-2365", commented, { handback: true });
    await wake(commented);
    const comment = await cooledFor("p-2365", commented);
    assert.ok(comment > 300 && comment <= COOLDOWN, `cooled for ${comment}s, expected the whole cooldown`);
});

test("past the short window a step's ticket is a candidate again, a comment's is still cooled", async () => {
    const stepped = await held("p-2365", "stepped a while ago");
    const stepId = await post("p-2365", stepped, { step: true });
    await wake(stepped);
    backdate(stepped, stepId, 7 * 60, 6 * 60);
    assert.equal(await cooledFor("p-2365", stepped), 0, "the 5 minutes are over");

    const commented = await held("p-2365", "commented a while ago");
    const commentId = await post("p-2365", commented, { handback: true });
    await wake(commented);
    backdate(commented, commentId, 7 * 60, 6 * 60);
    assert.ok(await cooledFor("p-2365", commented) > 0, "the hour is not");
});

test("0 minutes never sinks a step's ticket", async () => {
    const stepped = await held("p-2365-zero", "a step on a project that never sinks them");
    await post("p-2365-zero", stepped, { step: true });
    await wake(stepped);
    assert.equal(await cooledFor("p-2365-zero", stepped), 0);
});

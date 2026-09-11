/**
 * #2369 — a moderator tags an agent's comment as a step (`then: continue`) the
 * agent did not post. What must hold, over the real routes:
 * - tagged, the agent's comment keeps the ticket in the agent's pool as a step
 *   would; the last actor does not move and the agent gets no new event;
 * - only a human may tag or untag; only an agent's comment without a decision
 *   can be tagged;
 * - removing the tag gives the comment back its handback; a step the agent
 *   posted itself cannot be removed;
 * - a tagged step dates from the tag, so an old comment is not flagged as a
 *   step nothing has followed.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2369-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, invalidateFlagsCache } = await import("../db/projects.js");
const { invalidateInboxAgg } = await import("../db/inbox-agg.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2369";
getDb();
// A fresh database numbers comments from 1, like tickets, and a comment id that
// equals a ticket id resolves to the ticket (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2369-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2369-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function workerReply(ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function workerActionable(id: number): Promise<boolean> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${P}&actionable=1&limit=500`);
    return (r.json as unknown as { id: number }[]).some((row) => row.id === id);
}
async function workerUnread(onTicket: number): Promise<number> {
    const r = await call(WORKER, "GET", "/api/unread?consumer_id=worker&limit=500");
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === onTicket).length;
}
function lastActor(id: number): string | null {
    return getDb().select({ a: schema.tickets.lastActor }).from(schema.tickets).where(eq(schema.tickets.id, id)).get()?.a ?? null;
}
function meta(messageId: number): Record<string, unknown> {
    const row = getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    return JSON.parse(row?.meta ?? "{}") as Record<string, unknown>;
}

test("a moderator's step tag keeps the ticket with the agent, silently; removing it hands the ticket back again", async () => {
    const t = ticket("the agent asks, then carries on anyway");
    const question = await workerReply(t, { handback: true });
    assert.equal(await workerActionable(t), false, "handed back: waiting on the reporter");
    const unreadBefore = await workerUnread(t);

    const tagged = await call(HUMAN, "POST", `/api/messages/${question}/step`);
    assert.equal(tagged.status, 200, JSON.stringify(tagged.json));
    assert.equal(await workerActionable(t), true, "tagged as a step, the ticket is the agent's again");
    assert.equal(lastActor(t), "worker", "the last actor does not move");
    assert.equal(await workerUnread(t), unreadBefore, "the agent is not notified");
    assert.deepEqual([meta(question).step, meta(question).handback, (meta(question).step_tagged as { by: string }).by], [true, false, "boss"]);

    const untagged = await call(HUMAN, "POST", `/api/messages/${question}/unstep`);
    assert.equal(untagged.status, 200, JSON.stringify(untagged.json));
    assert.equal(await workerActionable(t), false, "the tag removed, the ticket waits on the reporter again");
    assert.deepEqual([meta(question).step, meta(question).handback, meta(question).step_tagged], [undefined, true, undefined]);
});

test("only a human tags, only an agent's comment without a decision, and an agent's own step stays", async () => {
    const t = ticket("refusals");
    const plain = await workerReply(t, { handback: true });
    assert.equal((await call(WORKER, "POST", `/api/messages/${plain}/step`)).status, 403, "an agent cannot tag");
    assert.equal((await call(WORKER, "POST", `/api/messages/${plain}/unstep`)).status, 403, "nor untag");

    const humanComment = submitMessage({ project: P, kind: "comment_added", ticket_id: t, body: "a human note", by_agent: "boss" }).id;
    assert.equal((await call(HUMAN, "POST", `/api/messages/${humanComment}/step`)).status, 409, "not a human's comment");

    const plan = await workerReply(t, { decision_kind: "plan" });
    assert.equal((await call(HUMAN, "POST", `/api/messages/${plan}/step`)).status, 409, "not a comment carrying a decision");

    const held = ticket("the agent's own step");
    assert.ok((await call(WORKER, "POST", `/api/tickets/${held}/assign`, {})).status < 300);
    const step = await workerReply(held, { step: true });
    assert.equal((await call(HUMAN, "POST", `/api/messages/${step}/unstep`)).status, 409, "a step the agent posted stays");
    assert.equal(meta(step).step, true);
});

test("a tagged step dates from the tag: an old comment is not flagged as a step nothing followed", async () => {
    const t = ticket("an old comment tagged today");
    const old = await workerReply(t, { handback: true });
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    getDb().update(schema.messages).set({ createdAt: twoDaysAgo }).where(eq(schema.messages.id, old)).run();
    invalidateInboxAgg();
    invalidateFlagsCache();

    assert.equal((await call(HUMAN, "POST", `/api/messages/${old}/step`)).status, 200);
    const r = await call(HUMAN, "GET", `/api/inbox?ids=${t}&project=${P}`);
    const row = (r.json as unknown as { latest_is_step: boolean; stalled_step: boolean }[])[0]!;
    assert.equal(row.latest_is_step, true);
    assert.equal(row.stalled_step, false);
});

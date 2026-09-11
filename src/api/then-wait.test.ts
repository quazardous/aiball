/**
 * #2297 step 2 — `then: wait` + `wait_for`: an agent says which ticket it waits
 * on. What must hold, over the real routes:
 * - a wait names an existing, open ticket other than itself; `wait_for` goes
 *   with `then: wait` only; a wait keeps the hand, so only the holder posts one;
 * - while pending, the ticket is blocked for its holder (tier blocked, not
 *   actionable), with no relation written and no decision gate of its own;
 * - when the waited ticket closes, the wait is accepted and the ticket gets a
 *   `dependency_closed` event: actionable again;
 * - a human lifts it earlier by rejecting it;
 * - a newer decision on the ticket supersedes the wait: it no longer blocks,
 *   and the waited ticket's close does not touch that newer decision.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2297w-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

const PROJECT = "p-2297w";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2297w-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2297w-w" }).token;
createProject({ name: PROJECT });
upsertSubscription("worker", PROJECT, "owner");

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
    return submitMessage({ project: PROJECT, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
function close(id: number): void {
    assert.equal(submitMessage({ project: PROJECT, kind: "ticket_closed", ticket_id: id, by_agent: "boss" }).status, "approved");
}
function reply(ticketId: number, extra: Record<string, unknown>) {
    return call(WORKER, "POST", "/api/messages", {
        project: PROJECT, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra,
    });
}
async function claim(ticketId: number): Promise<void> {
    const r = await call(WORKER, "POST", `/api/tickets/${ticketId}/assign`, {});
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function seat(id: number): Promise<{ actionable: boolean; backlog_tier: number | null; gated_by_decision: boolean }> {
    const r = await fetch(`${BASE}/api/tickets?project=${PROJECT}&open=1&limit=500`, { headers: { authorization: `Bearer ${WORKER}` } });
    const rows = await r.json() as { id: number; actionable: boolean; backlog_tier: number | null; gated_by_decision: boolean }[];
    const row = rows.find((x) => x.id === id);
    assert.ok(row, `#${id} listed for the worker`);
    return row!;
}
function decisionOf(messageId: number): { kind?: string; status?: string; wait_for?: number } {
    const meta = getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, messageId)).get()?.meta;
    return (JSON.parse(meta ?? "{}") as { decision?: { kind?: string; status?: string; wait_for?: number } }).decision ?? {};
}
function dependencyEvents(onTicket: number): number {
    return getDb().select({ id: schema.messages.id }).from(schema.messages)
        .where(and(eq(schema.messages.ticketId, onTicket), eq(schema.messages.kind, "dependency_closed"))).all().length;
}

test("a wait names an existing, open ticket other than itself, and wait_for goes with then: wait only", async () => {
    const waiting = ticket("wants to wait");
    const closed = ticket("already done");
    close(closed);
    const refusals: [Record<string, unknown>, RegExp][] = [
        [{ decision_kind: "wait" }, /needs wait_for/],
        [{ decision_kind: "wait", wait_for: waiting }, /cannot wait on itself/],
        [{ decision_kind: "wait", wait_for: 987654 }, /no such ticket/],
        [{ decision_kind: "wait", wait_for: closed }, /already closed/],
        [{ decision_kind: "plan", wait_for: closed }, /goes with then: wait only/],
        [{ handback: true, wait_for: closed }, /goes with then: wait only/],
    ];
    for (const [extra, why] of refusals) {
        const r = await reply(waiting, extra);
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.match(String(r.json.error), why, JSON.stringify(extra));
    }
    const open = ticket("an open one");
    const unclaimed = await reply(waiting, { decision_kind: "wait", wait_for: open });
    assert.equal(unclaimed.status, 409, "a wait keeps the hand: only the holder posts one");
    assert.match(String(unclaimed.json.error), /claim it first/);
});

test("a pending wait blocks the ticket, and the waited ticket's close lifts it with a dependency_closed event", async () => {
    const target = ticket("the one to wait for");
    const waiting = ticket("waits for it");
    await claim(waiting);
    const r = await reply(waiting, { decision_kind: "wait", wait_for: target });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    const waitId = r.json.id as number;
    assert.deepEqual(decisionOf(waitId), { kind: "wait", status: "pending", wait_for: target });

    const blocked = await seat(waiting);
    assert.equal(blocked.actionable, false);
    assert.equal(blocked.backlog_tier, 4, "blocked, even though the worker spoke last");
    assert.equal(blocked.gated_by_decision, false, "the target blocks it, not a decision gate");

    close(target);
    assert.equal(decisionOf(waitId).status, "accepted");
    assert.equal(dependencyEvents(waiting), 1);
    const after = await seat(waiting);
    assert.equal(after.actionable, true);
    assert.notEqual(after.backlog_tier, 4);
});

test("a human lifts a wait by rejecting it", async () => {
    const target = ticket("still open");
    const waiting = ticket("told to stop waiting");
    await claim(waiting);
    const waitId = (await reply(waiting, { decision_kind: "wait", wait_for: target })).json.id as number;
    assert.equal((await seat(waiting)).backlog_tier, 4);
    const d = await call(HUMAN, "POST", `/api/messages/${waitId}/decide`, { status: "rejected" });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const after = await seat(waiting);
    assert.equal(after.actionable, true);
    assert.notEqual(after.backlog_tier, 4);
});

test("a newer decision supersedes the wait: no longer blocked, and the target's close leaves that decision alone", async () => {
    const target = ticket("waited, then not");
    const waiting = ticket("waits, then proposes a plan");
    await claim(waiting);
    await reply(waiting, { decision_kind: "wait", wait_for: target });
    const planId = (await reply(waiting, { decision_kind: "plan" })).json.id as number;
    assert.notEqual((await seat(waiting)).backlog_tier, 4, "the plan is the latest decision now");
    close(target);
    assert.equal(decisionOf(planId).status, "pending", "the close accepts waits, not the plan that replaced one");
});

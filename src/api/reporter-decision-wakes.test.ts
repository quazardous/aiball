/**
 * #2380 david `75jv33` — the outcome of a decision wakes the agent whose
 * proposal was decided, and nobody else. A reporter used to be woken by every
 * accept on their ticket, including decisions they cannot take (no MCP tool
 * accepts a plan) and that ask them nothing. What must hold, over the real
 * routes:
 * - accepting a plan wakes its author, not the ticket's reporter;
 * - the reporter still hears what concerns them: the agent's comment, and the
 *   close — which david keeps, since it can unblock tickets on their side;
 * - a rejection behaves the same way as an accept;
 * - accepting a resolution closes the ticket in the same gesture: the reporter
 *   hears the close, the proposer hears the accept, one wake each.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2380-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2380";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "reporter", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2380-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2380-w" }).token;
const REPORTER = issueToken({ kind: "agent", consumer_id: "reporter", label: "2380-r" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("reporter", P, "follower");

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
/** The reporter files it; the human approves so the thread is live. */
function ticketByReporter(title: string): number {
    const m = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "reporter" });
    submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }); // unrelated, keeps ids apart
    return m.id;
}
async function approve(messageId: number): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/messages/${messageId}/approve`, {});
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function propose(ticketId: number, kind: "plan" | "resolution"): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", decision_kind: kind,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return (r.json as { id: number }).id;
}
async function decide(messageId: number, status: "accepted" | "rejected"): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/messages/${messageId}/decide`, { status });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
/** The kinds waiting unseen for a consumer on this ticket. */
async function wakesFor(token: string, consumer: string, ticketId: number): Promise<string[]> {
    const r = await call(token, "GET", `/api/unread?consumer_id=${consumer}&limit=500`);
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { kind: string; ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === ticketId).map((m) => m.kind);
}

test("accepting a plan wakes its author, not the ticket's reporter", async () => {
    const t = ticketByReporter("filed by the reporter, planned by the worker");
    await approve(t);
    const plan = await propose(t, "plan");

    await decide(plan, "accepted");

    assert.ok((await wakesFor(WORKER, "worker", t)).includes("plan_accepted"), "the author of the plan hears the accept");
    assert.ok(!(await wakesFor(REPORTER, "reporter", t)).includes("plan_accepted"), "the reporter does not");
});

test("a rejection reaches the same single recipient", async () => {
    const t = ticketByReporter("a plan that gets knocked back");
    await approve(t);
    const plan = await propose(t, "plan");

    await decide(plan, "rejected");

    assert.ok((await wakesFor(WORKER, "worker", t)).includes("plan_rejected"), "the author hears it");
    assert.ok(!(await wakesFor(REPORTER, "reporter", t)).includes("plan_rejected"), "the reporter does not");
});

test("the reporter still hears the agent's comment and the close", async () => {
    const t = ticketByReporter("what the reporter must keep hearing");
    await approve(t);
    const r1 = await call(WORKER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "a word for the reporter", summary_until: "s", handback: true,
    });
    assert.ok(r1.status < 300, JSON.stringify(r1.json));
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: t, by_agent: "boss" });

    const kinds = await wakesFor(REPORTER, "reporter", t);
    assert.ok(kinds.includes("comment_added"), "a comment on their ticket");
    assert.ok(kinds.includes("ticket_closed"), "and the close, which can unblock work on their side");
});

test("accepting a resolution: the reporter hears the close, the proposer the accept — one each", async () => {
    const t = ticketByReporter("resolved and closed in one gesture");
    await approve(t);
    const resolution = await propose(t, "resolution");

    await decide(resolution, "accepted");

    const reporterWakes = await wakesFor(REPORTER, "reporter", t);
    const workerWakes = await wakesFor(WORKER, "worker", t);
    assert.deepEqual(reporterWakes.filter((k) => k === "ticket_closed" || k === "resolution_accepted"), ["ticket_closed"],
        "the reporter hears the close, not the accept");
    assert.deepEqual(workerWakes.filter((k) => k === "ticket_closed" || k === "resolution_accepted"), ["resolution_accepted"],
        "the proposer hears the accept, and is not woken twice for one gesture");
});

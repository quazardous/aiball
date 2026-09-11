/**
 * #2370 — an inbox row's decision badges follow the ticket's LATEST decision,
 * the one the actionable gate reads. They used to follow the latest decision of
 * each kind: a resolution nobody decided, replaced since by newer plans, kept
 * "resolution proposed" lit on a ticket its agent was working. What must hold,
 * over the real routes:
 * - a pending decision replaced by a newer one of another kind lights nothing;
 * - the ticket's latest decision still lights its badge;
 * - a rejection replaced by a newer decision no longer shows;
 * - a decision the ticket was filed with is replaced by the first decision in
 *   its thread.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2370-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2370";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2370-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2370-w" }).token;
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
async function propose(ticketId: number, kind: "plan" | "resolution"): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: kind, summary_until: "s", decision_kind: kind });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function decide(messageId: number, status: "accepted" | "rejected"): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/messages/${messageId}/decide`, { status });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
type Row = { pending_resolution: boolean; pending_plan: boolean; latest_resolution_rejected: boolean; pending_decision_is_latest: boolean };
async function row(ticketId: number): Promise<Row> {
    const r = await call(HUMAN, "GET", `/api/inbox?ids=${ticketId}&project=${P}`);
    const rows = r.json as unknown as Row[];
    assert.equal(rows.length, 1, JSON.stringify(r.json));
    return rows[0]!;
}

test("a pending resolution replaced by a newer plan lights nothing for the resolution", async () => {
    const t = ticket("resolution, then plans");
    await propose(t, "resolution");
    const plan = await propose(t, "plan");
    let r = await row(t);
    assert.deepEqual([r.pending_resolution, r.pending_plan], [false, true], "the newer plan is the pending one");
    await decide(plan, "accepted");
    r = await row(t);
    assert.deepEqual([r.pending_resolution, r.pending_plan], [false, false], "an accepted plan leaves nothing pending");
});

test("the ticket's latest decision still lights its badge", async () => {
    const t = ticket("a resolution, the latest decision");
    await propose(t, "plan").then((plan) => decide(plan, "accepted"));
    await propose(t, "resolution");
    const r = await row(t);
    assert.deepEqual([r.pending_resolution, r.pending_plan, r.pending_decision_is_latest], [true, false, true]);
});

test("a rejection replaced by a newer decision no longer shows", async () => {
    const t = ticket("resolution rejected, then a plan");
    await propose(t, "resolution").then((res) => decide(res, "rejected"));
    assert.equal((await row(t)).latest_resolution_rejected, true, "the rejection is the latest decision");
    await propose(t, "plan").then((plan) => decide(plan, "accepted"));
    assert.equal((await row(t)).latest_resolution_rejected, false, "a newer decision replaces it");
});

test("a decision the ticket was filed with is replaced by the first decision in its thread", async () => {
    const created = await call(WORKER, "POST", "/api/messages", { project: P, kind: "ticket_created", title: "filed with a plan", body: "x", decision_kind: "plan" });
    assert.ok(created.status < 300, JSON.stringify(created.json));
    const t = created.json.id as number;
    if (created.json.status === "pending") assert.ok((await call(HUMAN, "POST", `/api/messages/${t}/approve`)).status < 300);
    assert.equal((await row(t)).pending_plan, true, "the plan it was filed with is pending");
    await propose(t, "resolution");
    const r = await row(t);
    assert.deepEqual([r.pending_plan, r.pending_resolution], [false, true], "the thread's resolution replaces it");
});

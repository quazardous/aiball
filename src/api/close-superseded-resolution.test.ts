/**
 * #2371 — closing a ticket accepts its pending resolution only when that
 * resolution is the ticket's latest decision. It used to accept every pending
 * resolution in the thread, so a resolution replaced days ago by newer plans
 * was accepted at the close and marked the ticket resolved. What must hold,
 * through a real close:
 * - the latest pending resolution is accepted and the ticket is resolved, even
 *   when a plain comment (not a decision) follows it;
 * - a resolution replaced by a newer plan, pending or accepted, stays pending
 *   in its comment and the ticket is not resolved.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2371-"));
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

const P = "p-2371";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2371-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2371-w" }).token;
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
async function reply(ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
function close(ticketId: number): void {
    assert.equal(submitMessage({ project: P, kind: "ticket_closed", ticket_id: ticketId, by_agent: "boss" }).status, "approved");
}
function decisionStatus(messageId: number): string | undefined {
    const row = getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    return (JSON.parse(row?.meta ?? "{}") as { decision?: { status?: string } }).decision?.status;
}
async function resolved(ticketId: number): Promise<boolean> {
    const r = await call(HUMAN, "GET", `/api/tickets/${ticketId}`);
    const t = (r.json.ticket ?? r.json) as { resolved?: boolean };
    return t.resolved === true;
}

test("the latest pending resolution is accepted at the close, a plain comment after it notwithstanding", async () => {
    const t = ticket("resolution, then a plain comment");
    const resolution = await reply(t, { decision_kind: "resolution" });
    await reply(t, { handback: true });
    close(t);
    assert.equal(decisionStatus(resolution), "accepted");
    assert.equal(await resolved(t), true);
});

test("a resolution replaced by a newer plan stays pending at the close, and the ticket is not resolved", async () => {
    const pendingPlan = ticket("resolution, then a pending plan");
    const res1 = await reply(pendingPlan, { decision_kind: "resolution" });
    await reply(pendingPlan, { decision_kind: "plan" });
    close(pendingPlan);
    assert.equal(decisionStatus(res1), "pending", "replaced by a pending plan");
    assert.equal(await resolved(pendingPlan), false);

    const acceptedPlan = ticket("resolution, then an accepted plan");
    const res2 = await reply(acceptedPlan, { decision_kind: "resolution" });
    const plan = await reply(acceptedPlan, { decision_kind: "plan" });
    assert.ok((await call(HUMAN, "POST", `/api/messages/${plan}/decide`, { status: "accepted" })).status < 300);
    close(acceptedPlan);
    assert.equal(decisionStatus(res2), "pending", "replaced by an accepted plan");
    assert.equal(await resolved(acceptedPlan), false);
});

test("a rejected resolution, the latest decision, is not accepted at the close", async () => {
    const t = ticket("resolution rejected, then closed");
    const resolution = await reply(t, { decision_kind: "resolution" });
    assert.ok((await call(HUMAN, "POST", `/api/messages/${resolution}/decide`, { status: "rejected" })).status < 300);
    close(t);
    assert.equal(decisionStatus(resolution), "rejected");
    assert.equal(await resolved(t), false);
});

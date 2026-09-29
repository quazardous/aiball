/**
 * #2383 — marking a step from the TICKET (a button in the thread, a bulk action
 * in the list) rather than from a comment's classify menu. The route tags the
 * ticket's latest comment, which must be an agent's. What must hold, over the
 * bus:
 * - the ticket goes back to the agent, exactly as the comment-level tag does,
 *   and the tag can be removed the same way;
 * - only a human may ask;
 * - a ticket whose last word is a human's, one with no comment at all, and one
 *   whose latest comment carries a decision are refused, each with its reason.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2383-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2383";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2383-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2383-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    return asToken<Record<string, unknown>>(token, method, params);
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function workerReply(ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await call(WORKER, "message.post", { project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function workerActionable(id: number): Promise<boolean> {
    const r = await call(WORKER, "ticket.list", { project: P, actionable: true, limit: 500 });
    return (r.json as unknown as { id: number }[]).some((row) => row.id === id);
}
function meta(messageId: number): Record<string, unknown> {
    const row = getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    return JSON.parse(row?.meta ?? "{}") as Record<string, unknown>;
}

test("marking the ticket as a step tags its latest agent comment, and removing it undoes that", async () => {
    const t = ticket("the agent asked, then carried on");
    await workerReply(t, { handback: true });
    const last = await workerReply(t, { handback: true });
    assert.equal(await workerActionable(t), false, "handed back: waiting on the reporter");

    const tagged = await call(HUMAN, "ticket.step", { id: t });
    assert.equal(tagged.status, 200, JSON.stringify(tagged.json));
    assert.equal(await workerActionable(t), true, "the ticket is the agent's again");
    assert.equal(meta(last).step, true, "the LATEST comment is the one tagged");

    assert.equal((await call(HUMAN, "ticket.unstep", { id: t })).status, 200);
    assert.equal(await workerActionable(t), false);
    assert.equal(meta(last).step, undefined);
});

test("only a human asks, and a thread whose last word is not an agent's plain comment is refused with its reason", async () => {
    const t = ticket("refusals");
    await workerReply(t, { handback: true });
    assert.equal((await call(WORKER, "ticket.step", { id: t })).status, 403, "an agent cannot ask");

    const empty = ticket("no comment at all");
    const noComment = await call(HUMAN, "ticket.step", { id: empty });
    assert.equal(noComment.status, 409);
    assert.match(String(noComment.json.error), /no comment/);

    submitMessage({ project: P, kind: "comment_added", ticket_id: t, body: "my word is last", by_agent: "boss" });
    const humanLast = await call(HUMAN, "ticket.step", { id: t });
    assert.equal(humanLast.status, 409);
    assert.match(String(humanLast.json.error), /last word is a human's/);

    const planned = ticket("the agent's last word is a plan");
    await workerReply(planned, { decision_kind: "plan" });
    const onDecision = await call(HUMAN, "ticket.step", { id: planned });
    assert.equal(onDecision.status, 409);
    assert.match(String(onDecision.json.error), /decision/);
});

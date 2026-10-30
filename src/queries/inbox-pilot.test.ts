/**
 * #3005 — `inbox.list` with `view: "turn"` (#3038; it was `v=tvty`) gives each row whose turn it is, its band and its
 * state glyph, computed by the server for the viewer. What must hold, over the
 * bus:
 * - `turn` follows the actionable gate, not the last comment: a decision taken
 *   or a ticket reopened without a word hands the ball over; a viewer alone on
 *   a thread keeps it; a step keeps it with its author;
 * - a pending decision proposed by someone else puts the row in the decision
 *   band, and outranks a later step for the glyph;
 * - without `view`, the rows are exactly what they were, and `v=tvty` no longer
 *   adds anything; `sort=band` orders by band.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3005-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { BANDS } = await import("./inbox-pilot.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");
const { computeActionableTicketIds } = await import("../db/projects.js");
const { buildBacklogRulesCtx, defaultBacklogRules } = await import("../db/backlog-rules.js");

const P = "p-3005";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3005-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3005-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: unknown }> {
    return asToken(token, method, params);
}
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function comment(token: string, ticketId: number, extra: Record<string, unknown> = {}): Promise<number> {
    const r = await call(token, "message.post", { project: P, kind: "comment_added", ticket_id: ticketId, body: "c", summary_until: "s", handback: true, ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return (r.json as { id: number }).id;
}
async function decide(messageId: number, status: "accepted" | "rejected"): Promise<void> {
    const r = await call(HUMAN, "message.decide", { id: messageId, status });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
type Row = { id: number; last_speaker: string; turn?: string; band?: number; band_name?: string; state_glyph?: string | null; unread?: boolean };
async function row(ticketId: number, token = HUMAN): Promise<Row> {
    const r = await call(token, "inbox.list", { view: "turn", ids: [ticketId], project: P });
    const rows = (r.json as { rows: Row[] }).rows;
    assert.equal(rows.length, 1, JSON.stringify(r.json));
    // Every turn row names its band: a client reads the name, not the index.
    assert.equal(rows[0]!.band_name, BANDS[rows[0]!.band!], "band_name is BANDS[band]");
    return rows[0]!;
}
const band = (name: (typeof BANDS)[number]) => BANDS.indexOf(name);

test("a plan accepted without a comment hands the ball to the agent, though the agent spoke last", async () => {
    const t = ticket("plan accepted silently");
    const plan = await comment(WORKER, t, { decision_kind: "plan", handback: undefined });
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["you", band("decision"), "plan"]);
    await decide(plan, "accepted");
    r = await row(t);
    assert.equal(r.last_speaker, "worker", "a client reading last_speaker would say it is the human's turn");
    assert.equal(r.turn, "them");
    assert.equal(r.state_glyph, null);
});

test("a ticket reopened without a comment hands the ball back", async () => {
    const t = ticket("reopened silently");
    await comment(WORKER, t);
    assert.ok((await call(HUMAN, "message.post", { project: P, kind: "ticket_closed", ticket_id: t })).status < 300);
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["none", band("closed"), "closed"]);
    assert.ok((await call(HUMAN, "message.post", { project: P, kind: "ticket_reopened", ticket_id: t })).status < 300);
    r = await row(t);
    assert.equal(r.last_speaker, "worker");
    assert.equal(r.turn, "them");
});

test("a viewer alone on a thread, commenting several times, keeps the ball", async () => {
    const t = ticket("alone");
    await comment(HUMAN, t);
    await comment(HUMAN, t);
    assert.equal((await row(t)).turn, "you");
});

test("a step keeps the ball with its author, withdraws its own pending decision, and yields to another's", async () => {
    const t = ticket("step");
    await comment(WORKER, t, { step: true, step_after_minutes: 0, handback: undefined });
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph, r.unread], ["them", band("working"), "step", true], "unread is a flag on the row, not a band: it stays where its work is");
    assert.ok((await call(HUMAN, "ticket.mark_read", { id: t })).status < 300);
    r = await row(t);
    assert.equal(r.band, band("working"));
    assert.equal((await row(t, WORKER)).turn, "you", "for its author, a step is still its turn");

    const u = ticket("plan then step");
    await comment(WORKER, u, { decision_kind: "plan", handback: undefined });
    await comment(WORKER, u, { step: true, step_after_minutes: 0, handback: undefined });
    r = await row(u);
    assert.deepEqual([r.band, r.state_glyph], [band("working"), "step"], "the author's step withdrew its own plan");

    // Someone else's pending decision stays: only its author withdraws it.
    const v = ticket("human's plan, agent's step");
    await comment(HUMAN, v, { decision_kind: "plan", handback: undefined });
    await comment(WORKER, v, { step: true, step_after_minutes: 0, handback: undefined });
    r = await row(v, WORKER);
    assert.deepEqual([r.band, r.state_glyph], [band("decision"), "plan"], "a pending decision outranks another's step");
});

test("a comment handing the ticket back shows as a question; one keeping the hand is not the others' turn", async () => {
    const asked = ticket("asked");
    await comment(WORKER, asked, { handback: true });
    let r = await row(asked);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["you", band("decision"), "question"], "the question waits on the human, like a decision");
    r = await row(asked, WORKER);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["them", band("open"), "question"], "the glyph is the ticket's state, the band follows who has to move");

    // Moderation still comes first: a question on a ticket awaiting moderation stays there.
    const held = ticket("held");
    await comment(WORKER, held, { handback: true });
    updateMessageStatus(held, "pending", "human");
    assert.equal((await row(held)).band, band("moderate"));

    const kept = ticket("kept");
    await comment(WORKER, kept, { handback: false });
    r = await row(kept);
    assert.deepEqual([r.turn, r.state_glyph], ["them", null], "the agent said it carries on");
    assert.equal((await row(kept, WORKER)).turn, "you", "for its author it is still its turn");

    // A comment that says no handback (one written before it existed) reads as before.
    const legacy = ticket("legacy");
    submitMessage({ project: P, kind: "comment_added", ticket_id: legacy, body: "older", by_agent: "worker", summary_until: "s" });
    r = await row(legacy);
    assert.deepEqual([r.turn, r.state_glyph], ["you", null], "no handback on the last word: the turn and glyph read as before");
});

test("a human's comment keeping the hand: not the agents' turn, not actionable, no ping, until the next action", async () => {
    const pingsOf = (id: number) => getDb().select().from(schema.pings).where(eq(schema.pings.commentId, id)).all().map((p) => p.recipient);
    const actionable = (id: number) => computeActionableTicketIds("worker", [id]).actionableIds.has(id);

    const t = ticket("human keeps");
    await comment(WORKER, t, { handback: true });
    assert.equal(actionable(t), false, "the worker spoke last");
    const kept = await comment(HUMAN, t, { handback: false });
    const r = await row(t);
    assert.deepEqual([r.turn, r.state_glyph], ["you", null], "the ball is the human's");
    assert.equal((await row(t, WORKER)).turn, "them");
    assert.equal(actionable(t), false, "not the agent's turn");
    assert.deepEqual(pingsOf(kept), [], "the comment pings no one");
    const ctx = buildBacklogRulesCtx("worker");
    assert.equal(defaultBacklogRules.excludes(ctx, { ticketId: t, ticketByAgent: "boss", assignee: null, project: P }, "backlog-tier"), true, "no backlog wake brings it up");

    // A held ticket is held from its holder too.
    assert.ok((await call(WORKER, "ticket.claim", { id: t })).status < 500);
    assert.equal(actionable(t), false, "the holder waits too");

    // The human's next comment hands over, as usual.
    await comment(HUMAN, t, { handback: undefined });
    assert.equal(actionable(t), true, "a plain comment moves the hand");

    // A decision ends it too.
    const u = ticket("kept then decided");
    const plan = await comment(WORKER, u, { decision_kind: "plan", handback: undefined });
    await comment(HUMAN, u, { handback: false });
    assert.equal(actionable(u), false);
    await decide(plan, "accepted");
    assert.equal(actionable(u), true, "the decision hands over");

    // An @mention in it is an explicit call: it still reaches, the ticket stays out of the pool.
    const v = ticket("mention");
    const called = await comment(HUMAN, v, { handback: false, body: "@worker a look" });
    assert.deepEqual(pingsOf(called), ["worker"], "the mention still pings");
    assert.equal(actionable(v), false);

    // An agent's own handback: false is not this rule.
    const w = ticket("agent keeps");
    await comment(WORKER, w, { handback: false });
    assert.equal(actionable(w), true, "the agent carries on");

    // A human's comment with no handback hands over and pings.
    const x = ticket("plain");
    const plain = await comment(HUMAN, x, { handback: undefined });
    assert.ok(pingsOf(plain).includes("worker"), "a plain comment pings the owner");
    assert.equal(actionable(x), true);
});

test("a step withdraws its author's pending decision: nothing left to accept, the thread keeps the trace", async () => {
    const decisionOf = (id: number) => (JSON.parse(getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, id)).get()!.meta!) as { decision: { status: string; kind: string } }).decision;
    const t = ticket("resolved, then more work");
    const res = await comment(WORKER, t, { decision_kind: "resolution", handback: undefined });
    assert.equal((await row(t)).state_glyph, "resolution");
    const step = await comment(WORKER, t, { step: true, step_after_minutes: 0, handback: undefined });
    assert.deepEqual([decisionOf(res).status, decisionOf(res).kind], ["withdrawn", "resolution"]);
    assert.equal((JSON.parse(getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, step)).get()!.meta!) as { step_withdrew: number }).step_withdrew, res, "the step names what it withdrew");
    const r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["them", band("working"), "step"], "no more Accept");
    assert.equal(computeActionableTicketIds("worker", [t]).actionableIds.has(t), true, "the agent carries on");
    const late = await call(HUMAN, "message.decide", { id: res, status: "accepted" });
    assert.ok(late.status >= 400, `a withdrawn decision cannot be accepted: ${JSON.stringify(late.json)}`);

    // A plan filed with the ticket, by its reporter who leads the project, goes the same way.
    const filed = submitMessage({ project: P, kind: "ticket_created", title: "filed with a plan", body: "x", by_agent: "worker", decision_kind: "plan" }).id;
    updateMessageStatus(filed, "approved", "human", null, "ticket_created");
    assert.equal((await row(filed)).state_glyph, "plan");
    await comment(WORKER, filed, { step: true, step_after_minutes: 0, handback: undefined });
    assert.equal((await row(filed)).state_glyph, "step");
});

test("a plan with options is accepted on one of them, recorded on the decision and named by its event", async () => {
    const OPTIONS = [{ key: "A", label: "the gesture", recommended: true }, { key: "B", label: "the step" }];
    const t = ticket("a choice");
    const plan = await comment(WORKER, t, { decision_kind: "plan", handback: undefined, options: OPTIONS, multiple: false });
    const decide = (extra: Record<string, unknown>) => call(HUMAN, "message.decide", { id: plan, status: "accepted", ...extra });
    assert.equal((await decide({})).status, 400, "an accept with no option is refused");
    assert.equal((await decide({ option: "Z" })).status, 400, "and one the plan does not offer");
    assert.equal((await row(t)).state_glyph, "plan", "still waiting");
    const done = await decide({ option: "B" });
    assert.ok(done.status < 300, JSON.stringify(done.json));
    const meta = (id: number) => JSON.parse(getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, id)).get()!.meta!);
    assert.equal(meta(plan).decision.option, "B");
    assert.equal(meta(plan).decision.options.length, 2, "the choices stay on the decision");
    const event = getDb().select({ body: schema.messages.body }).from(schema.messages).where(and(eq(schema.messages.ticketId, t), eq(schema.messages.kind, "plan_accepted"))).get();
    assert.equal(event?.body, "option B: the step", "the wake reads it from the event");

    // A rejection needs no option; a plan without options takes none.
    const u = ticket("rejected");
    const other = await comment(WORKER, u, { decision_kind: "plan", handback: undefined, options: OPTIONS, multiple: false });
    assert.ok((await call(HUMAN, "message.decide", { id: other, status: "rejected" })).status < 300);
    const v = ticket("plain plan");
    const plain = await comment(WORKER, v, { decision_kind: "plan", handback: undefined });
    assert.equal((await call(HUMAN, "message.decide", { id: plain, status: "accepted", option: "A" })).status, 400);
    assert.ok((await call(HUMAN, "message.decide", { id: plain, status: "accepted" })).status < 300);

    // Bad shapes are refused, and only a plan offers options.
    const bad = async (extra: Record<string, unknown>) => (await call(WORKER, "message.post", { project: P, kind: "comment_added", ticket_id: ticket("bad"), body: "c", summary_until: "s", decision_kind: "plan", ...extra })).status;
    assert.equal(await bad({ multiple: false, options: [{ key: "A", label: "alone" }] }), 400, "at least two");
    assert.equal(await bad({ multiple: false, options: [{ key: "A", label: "x" }, { key: "A", label: "y" }] }), 400, "unique keys");
    assert.equal(await bad({ multiple: false, options: [{ key: "A", label: "x", recommended: true }, { key: "B", label: "y", recommended: true }] }), 400, "one recommended");
    assert.equal(await bad({ decision_kind: "resolution", multiple: false, options: OPTIONS }), 400, "only a plan");
    assert.equal(await bad({ options: OPTIONS }), 400, "multiple is mandatory");

    // #4474 — a plan that takes several.
    const many = ticket("several");
    const several = await comment(WORKER, many, { decision_kind: "plan", handback: undefined, options: [...OPTIONS, { key: "C", label: "third" }], multiple: true });
    const pick = (extra: Record<string, unknown>) => call(HUMAN, "message.decide", { id: several, status: "accepted", ...extra });
    assert.equal((await pick({})).status, 400, "at least one");
    assert.equal((await pick({ options: [] })).status, 400);
    assert.equal((await pick({ option: "A" })).status, 400, "a list, not one");
    assert.equal((await pick({ options: ["A", "Z"] })).status, 400, "only what it offers");
    const both = await pick({ options: ["A", "C"] });
    assert.ok(both.status < 300, JSON.stringify(both.json));
    assert.deepEqual(meta(several).decision.chosen, ["A", "C"]);
    const manyEvent = getDb().select({ body: schema.messages.body }).from(schema.messages).where(and(eq(schema.messages.ticketId, many), eq(schema.messages.kind, "plan_accepted"))).get();
    assert.equal(manyEvent?.body, "options A, C: the gesture; third");
    // A plan that takes one refuses a list.
    const w = ticket("exactly one");
    const one = await comment(WORKER, w, { decision_kind: "plan", handback: undefined, options: OPTIONS, multiple: false });
    assert.equal((await call(HUMAN, "message.decide", { id: one, status: "accepted", options: ["A"] })).status, 400);
});

test("a pending plan's options can be changed by its author or a human, and removed", async () => {
    const A = { key: "A", label: "first" }, B = { key: "B", label: "second" }, C = { key: "C", label: "third" };
    const optionsOf = (id: number) => (JSON.parse(getDb().select({ meta: schema.messages.meta }).from(schema.messages).where(eq(schema.messages.id, id)).get()!.meta!) as { decision: { options?: Array<{ key: string }> } }).decision.options?.map((o) => o.key);
    const set = (token: string, id: number, options: unknown[]) => call(token, "message.set_options", { id, options, ...(options.length ? { multiple: false } : {}) });
    const t = ticket("options move");
    const plan = await comment(WORKER, t, { decision_kind: "plan", handback: undefined });
    assert.ok((await set(WORKER, plan, [A, B])).status < 300, "added to a plain plan");
    assert.deepEqual(optionsOf(plan), ["A", "B"]);
    assert.ok((await set(HUMAN, plan, [A, B, C])).status < 300, "a human too");
    assert.deepEqual(optionsOf(plan), ["A", "B", "C"]);
    assert.equal((await set(WORKER, plan, [A])).status, 400, "one option is not a choice");
    assert.ok((await set(WORKER, plan, [])).status < 300, "an empty list makes it a plain plan");
    assert.equal(optionsOf(plan), undefined);
    assert.ok((await call(HUMAN, "message.decide", { id: plan, status: "accepted" })).status < 300, "and it takes a plain accept");
    assert.equal((await set(WORKER, plan, [A, B])).status, 409, "not once decided");

    // Someone else's plan is not an agent's to change.
    const u = ticket("human's plan");
    const theirs = await comment(HUMAN, u, { decision_kind: "plan", handback: undefined });
    assert.equal((await set(WORKER, theirs, [A, B])).status, 403);
});

test("the decision band is the viewer's to decide, not the proposer's", async () => {
    const t = ticket("worker's own plan");
    await comment(WORKER, t, { decision_kind: "plan", handback: undefined });
    await comment(HUMAN, t);
    let r = await row(t);
    assert.deepEqual([r.turn, r.band], ["them", band("decision")], "a question after the plan: the plan still waits on the human");
    r = await row(t, WORKER);
    assert.notEqual(r.band, band("decision"), "the proposer does not decide its own plan");
});

test("without the view the rows are unchanged, the old name adds nothing, and sort=band orders by band", async () => {
    for (const q of [{ project: P }, { v: "tvty", project: P }]) {
        const plain = await call(HUMAN, "inbox.list", q);
        for (const r of (plain.json as { rows: Row[] }).rows) assert.ok(!("turn" in r) && !("band" in r) && !("state_glyph" in r), JSON.stringify(q));
    }
    const sorted = ((await call(HUMAN, "inbox.list", { view: "turn", sort: "band", project: P })).json as { rows: Row[] }).rows;
    const bands = sorted.map((r) => r.band!);
    assert.deepEqual(bands, [...bands].sort((a, b) => a - b));
    assert.ok(new Set(bands).size > 2, "several bands are exercised");
});

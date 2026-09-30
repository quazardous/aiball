/**
 * #3388 — every write of a ticket or of its thread says `ticketChanged` once,
 * after the write, naming what it touched. The copies of a ticket's state (the
 * inbox aggregate, the actionable sets, the bus's subjects) hear it instead of
 * being called by each write: a write that forgets to say it is caught here.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3388-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
after(() => rmSync(home, { recursive: true, force: true }));

const { upsertConsumer } = await import("../db.js");
const { createProject } = await import("./projects.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
const { testCaller } = await import("../tests/lib.js");
const { onTicketChanged, ticketChanged } = await import("./ticket-change.js");
type TicketChange = import("./ticket-change.js").TicketChange;
const m = await import("./messages.js");
const t = await import("./tickets.js");
const { setTicketMilestone } = await import("./milestones.js");
const { trimStepWaits } = await import("./wait-credit.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
createProject({ name: "changes" });
createProject({ name: "changes-2" });
const boss = testCaller("boss", { kind: "human" });
const post = async (p: Record<string, unknown>) => getMethod("message.post")!.run(boss, p) as Promise<{ id: number }>;
const ticket = async (title: string, extra: Record<string, unknown> = {}) => (await post({ kind: "ticket_created", project: "changes", title, body: "b", ...extra })).id;
const comment = async (id: number, extra: Record<string, unknown> = {}) => (await post({ kind: "comment_added", ticket_id: id, body: "c", ...extra })).id;

/** What one write said. */
function said(write: () => unknown): TicketChange[] {
    const heard: TicketChange[] = [];
    const off = onTicketChanged((c) => heard.push(c));
    try { write(); } finally { off(); }
    return heard;
}
const onThread = (id: number, project = "changes"): TicketChange => ({ ticket_ids: [id], thread: { ticket_id: id, project } });
const onRow = (id: number): TicketChange => ({ ticket_ids: [id], thread: null });

test("a write on a thread says it once, naming the thread and its project", async () => {
    const id = await ticket("t");
    const c = await comment(id);
    const plan = await comment(id, { decision_kind: "plan" });
    const res = await comment(id, { decision_kind: "resolution" });
    const stepped = await comment(id);
    const cases: [string, () => unknown][] = [
        ["a status flip", () => m.updateMessageStatus(c, "rejected", "human", null, "comment_added")],
        ["an edit", () => m.editMessage(c, { body: "edited" } as never)],
        ["a decision", () => m.applyMessageDecision(plan, "accepted", "boss")],
        ["a reclassified decision", () => m.reclassifyMessageDecision(res, "plan")],
        ["a removed decision", () => m.removeMessageDecision(res)],
        ["a promoted decision", () => m.promoteMessageToDecision(res, "plan", undefined, "boss")],
        ["a step tagged", () => m.tagMessageAsStep(stepped, "boss")],
        ["a step untagged", () => m.untagMessageStep(stepped)],
        ["a deleted comment", () => m.deleteComment(c, "boss")],
        ["a ticket approved", () => m.updateMessageStatus(id, "approved", "human", null, "ticket_created")],
    ];
    for (const [label, write] of cases) assert.deepEqual(said(write), [onThread(id)], label);
});

test("a post says its thread at each of its writes: the insert, then its approval", async () => {
    const id = await ticket("posted");
    const heard: TicketChange[] = [];
    const off = onTicketChanged((c) => heard.push(c));
    await comment(id);
    off();
    assert.deepEqual(heard, [onThread(id), onThread(id)]);
});

test("a relation says both tickets and the one thread it is written on", async () => {
    const a = await ticket("a");
    const b = await ticket("b");
    assert.deepEqual(
        said(() => m.insertTypedRelation({ source_ticket_id: a, target_ticket_id: b, relation_kind: "depends_on", by_agent: "boss" })),
        [{ ticket_ids: [a, b], thread: { ticket_id: a, project: "changes" } }],
    );
    assert.deepEqual(
        said(() => m.insertRelationEvent({ target_ticket_id: b, source_ticket_id: a, kind: "ticket_referenced", by_agent: "boss" })),
        [onThread(b)],
    );
});

test("a write on the ticket's own row says the ticket, and no thread", async () => {
    const id = await ticket("row");
    const milestone = await ticket("m", { level: "milestone" });
    const cases: [string, () => unknown][] = [
        ["a claim", () => t.setTicketClaim(id, "worker")],
        ["a claim released", () => t.releaseTicketClaim(id)],
        ["an assignment", () => t.setTicketAssignment(id, "worker", "boss")],
        ["an assignment released", () => t.releaseTicketAssignment(id)],
        ["a snooze", () => t.setTicketPostpone(id, new Date(Date.now() + 3_600_000).toISOString())],
        ["a new owner", () => t.setTicketOwner(id, "worker")],
        ["a milestone", () => setTicketMilestone(id, milestone)],
    ];
    for (const [label, write] of cases) assert.deepEqual(said(write), [onRow(id)], label);
});

test("a ticket filed with a level says its row again: who sees it depends on the level", async () => {
    const heard: TicketChange[] = [];
    const off = onTicketChanged((c) => heard.push(c));
    const id = await ticket("leveled", { level: "milestone" });
    off();
    assert.ok(heard.some((c) => c.thread === null && c.ticket_ids[0] === id), "the level write said the row");
});

test("a step trimmed says its thread; a moved thread says everything", async () => {
    const id = await ticket("waits");
    await getMethod("ticket.assign")!.run(boss, { id, assignee: "worker" });
    const worker = testCaller("worker");
    await getMethod("message.post")!.run(worker, { kind: "comment_added", ticket_id: id, body: "s", summary_until: "s", commits: null, step: true, step_after_minutes: 60 });
    assert.deepEqual(said(() => trimStepWaits(1)), [onThread(id)]);
    assert.deepEqual(said(() => m.moveTicket(id, "changes-2", "boss")).at(-1), { ticket_ids: [], thread: null, everything: true });
});

test("a listener that throws is logged and does not stop the others", () => {
    const heard: number[] = [];
    const log = console.error;
    console.error = () => {};
    const offs = [onTicketChanged(() => { throw new Error("broken"); }), onTicketChanged((c) => heard.push(c.ticket_ids[0]))];
    try { ticketChanged(onRow(7)); } finally { console.error = log; offs.forEach((off) => off()); }
    assert.deepEqual(heard, [7]);
});

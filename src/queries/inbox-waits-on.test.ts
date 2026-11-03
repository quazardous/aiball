/**
 * #4689 — a step waiting on another ticket keeps its row in the `working` band
 * (the agent is on it) and says what it waits on: `waits_on`, the awaited
 * ticket's band and glyph for the same caller; null once that ticket has moved,
 * and null for a row that waits on nothing.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4689-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { waitersOf } = await import("../db/wait-graph.js");

const P = "p-4689";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "4689-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "4689-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ticket = (title: string) => submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
async function post(token: string, ticketId: number, extra: Record<string, unknown>): Promise<number> {
    const r = await asToken(token, "message.post", { project: P, kind: "comment_added", ticket_id: ticketId, body: "c", summary_until: "s", ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return (r.json as { id: number }).id;
}
type Row = { id: number; band_name: string; state_glyph: string | null; waits_on: { id: number; kind: string; title: string; band_name: string; state_glyph: string | null; closed: boolean } | null };
async function row(id: number): Promise<Row> {
    const r = await asToken(HUMAN, "inbox.list", { view: "turn", ids: [id], project: P });
    return (r.json as { rows: Row[] }).rows[0]!;
}

test("a step waiting on a ticket whose escalation awaits the human", async () => {
    const awaited = ticket("install from a release");
    const escalation = await post(WORKER, awaited, { decision_kind: "escalation" });
    const waiter = ticket("the first public release");
    await post(WORKER, waiter, { step: true, step_resume_on_ticket: awaited });

    const r = await row(waiter);
    assert.equal(r.band_name, "working", "the agent is on it: the band does not move");
    assert.deepEqual(r.waits_on, { id: awaited, kind: "resume_on", title: "install from a release", band_name: "decision", state_glyph: "escalation", closed: false });
    assert.equal((await row(awaited)).waits_on, null, "the awaited ticket waits on nothing");
    assert.deepEqual(waitersOf(awaited), [waiter], "its waiters, for pushing their rows again");

    // The human decides: the awaited ticket moved, the step's wait is over.
    const d = await asToken(HUMAN, "message.decide", { id: escalation, status: "accepted" });
    assert.ok(d.status < 300, JSON.stringify(d.json));
    assert.equal((await row(waiter)).waits_on, null);
});

test("#4003 as it is: the step's wait ended when the awaited ticket moved, a depends_on holds it until that one closes", async () => {
    const awaited = ticket("installation and packaging");
    const waiter = ticket("versioning and the first release");
    // 08:48 the step names it; 08:53 the same agent escalates on it (it moved); 08:54 the dependency.
    await post(WORKER, waiter, { step: true, step_resume_on_ticket: awaited });
    await new Promise((r) => setTimeout(r, 5));
    await post(WORKER, awaited, { decision_kind: "escalation" });
    const rel = await asToken(WORKER, "ticket.relate", { id: waiter, target_ticket_id: awaited, kind: "depends_on" });
    assert.ok(rel.status < 300, JSON.stringify(rel.json));

    const r = await row(waiter);
    assert.equal(r.band_name, "working");
    assert.deepEqual(r.waits_on, { id: awaited, kind: "depends_on", title: "installation and packaging", band_name: "decision", state_glyph: "escalation", closed: false });
    assert.ok(waitersOf(awaited).includes(waiter), "a dependent is a waiter too");

    const closed = await asToken(HUMAN, "message.post", { project: P, kind: "ticket_closed", ticket_id: awaited });
    assert.ok(closed.status < 300, JSON.stringify(closed.json));
    assert.equal((await row(waiter)).waits_on, null, "closed: nothing left to wait on");
});

test("a step that waits on nothing, and a row that is not a step, say null", async () => {
    const t = ticket("on it now");
    await post(WORKER, t, { step: true, step_after_minutes: 0 });
    assert.deepEqual([(await row(t)).band_name, (await row(t)).waits_on], ["working", null]);
    const plain = ticket("nothing yet");
    assert.equal((await row(plain)).waits_on, null);
});

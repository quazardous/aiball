/**
 * #3811 — a step's `resume_on: { ticket }` that can never wake. Seen on
 * darktable: #3767 `depends_on` #3786, and #3786 was posted with
 * `resume_on: { ticket: 3767 }` — each waits on the other, and both sleep.
 * What must hold:
 * - `ticket_reply` refuses the step that closes such a cycle, through a
 *   `depends_on` or through another step's `resume_on`;
 * - it refuses a `resume_on` on a closed ticket;
 * - a wait in the right direction, or on a ticket that has moved since, passes;
 * - `graph_audit` reports the cycles and the dead resumes already there.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3811-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { insertTypedRelation } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { graphAudit } = await import("../db/graph-query.js");

const P = "p-3811";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3811-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function held(title: string): Promise<number> {
    const t = ticket(title);
    const r = await asToken(WORKER, "ticket.assign", { id: t });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return t;
}
function step(t: number, on: number) {
    return asToken(WORKER, "message.post", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true, step_resume_on_ticket: on,
    });
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("the darktable case: a step resuming on a ticket that depends_on this one is refused, naming the cycle", async () => {
    const blocker = await held("the blocker");
    const gated = ticket("the gated one");
    insertTypedRelation({ source_ticket_id: gated, target_ticket_id: blocker, relation_kind: "depends_on", by_agent: "boss" });
    const r = await step(blocker, gated);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    const body = r.json as { error?: string; code?: string };
    assert.equal(body.code, "STEP_RESUME_INVALID");
    assert.match(String(body.error), new RegExp(`#${gated} already waits on this ticket \\(#${gated} →depends_on #${blocker}\\)`));
    // The other direction is ordinary sequencing: the gated one waits on its blocker.
    await asToken(WORKER, "ticket.assign", { id: gated });
    const ok = await step(gated, blocker);
    assert.ok(ok.status < 300, JSON.stringify(ok.json));
});

test("two steps resuming on each other: the second is refused, through a chain", async () => {
    const a = await held("a");
    const b = await held("b");
    const c = await held("c");
    // Posted from the end of the chain: a step on b is b moving, which would end a's wait.
    assert.ok((await step(b, c)).status < 300);
    await tick();
    assert.ok((await step(a, b)).status < 300);
    await tick();
    const r = await step(c, a);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String((r.json as { error?: string }).error), new RegExp(`#${a} →resume_on #${b} →resume_on #${c}`));
});

test("a wait already over is no cycle: the awaited ticket moved after the step", async () => {
    const a = await held("a2");
    const b = await held("b2");
    assert.ok((await step(a, b)).status < 300);
    await tick();
    submitMessage({ project: P, kind: "comment_added", ticket_id: b, body: "b moved", by_agent: "boss" });
    await tick();
    const r = await step(b, a);
    assert.ok(r.status < 300, JSON.stringify(r.json));
});

test("a step resuming on a closed ticket is refused", async () => {
    const t = await held("waits on a closed one");
    const done = ticket("done");
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: done, by_agent: "boss" });
    const r = await step(t, done);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String((r.json as { error?: string }).error), new RegExp(`#${done} is closed`));
});

test("graph_audit reports the cycles and the dead resumes already on the board, first", async () => {
    // Written past the check, as the board held them before it.
    const x = ticket("x");
    const y = ticket("y");
    insertTypedRelation({ source_ticket_id: y, target_ticket_id: x, relation_kind: "depends_on", by_agent: "boss" });
    await tick();
    submitMessage({ project: P, kind: "comment_added", ticket_id: x, body: "b", summary_until: "s", by_agent: "boss", step: true, step_resume_on_ticket: y });
    const gone = ticket("gone");
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: gone, by_agent: "boss" });
    await tick();
    const z = ticket("z");
    await tick();
    submitMessage({ project: P, kind: "comment_added", ticket_id: z, body: "b", summary_until: "s", by_agent: "boss", step: true, step_resume_on_ticket: gone });

    const findings = graphAudit({ project: P }).findings;
    const cycle = findings.find((f) => f.kind === "wait_cycle" && f.ticket_ids.includes(x));
    assert.ok(cycle, JSON.stringify(findings));
    assert.deepEqual(cycle.ticket_ids, [x, y]);
    assert.match(cycle.detail, new RegExp(`#${x} →resume_on #${y}`));
    assert.match(cycle.detail, new RegExp(`#${y} →depends_on #${x}`));
    const dead = findings.find((f) => f.kind === "dead_resume");
    assert.deepEqual(dead?.ticket_ids, [z, gone]);
    assert.ok(["wait_cycle", "dead_resume"].includes(findings[0].kind), "the waits that never end come first");
});

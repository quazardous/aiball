/**
 * #3909 — a ticket parked with `resume_on: { ticket: N }` comes back when N
 * MOVES. Seen on helios: N's holder re-parked N with a `then: continue` that
 * delivered nothing, and every ticket parked on N woke, to re-park in turn and
 * wake the tickets parked on them. What must hold:
 * - a step on N that cites no commit does not end the wait;
 * - a step that cites a commit, a comment, a decision or a close does;
 * - the cycle check reads the same: a wait not ended is still a wait.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3909-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { ownFreshSteps } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { liveResumeOn } = await import("../db/wait-graph.js");
const { lastMoveAt } = await import("../db/last-move.js");

const P = "p-3909";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3909-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const tick = () => new Promise((r) => setTimeout(r, 5));
async function held(title: string): Promise<number> {
    const t = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
    const r = await asToken(WORKER, "ticket.assign", { id: t });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return t;
}
async function step(t: number, resume: { ticket?: number; timer?: number }, commits: string[] | null = null) {
    const r = await asToken(WORKER, "message.post", {
        project: P, kind: "comment_added", ticket_id: t, body: "b", summary_until: "s", step: true,
        ...(resume.ticket ? { step_resume_on_ticket: resume.ticket } : {}),
        ...(resume.timer !== undefined ? { step_after_minutes: resume.timer } : {}),
        commits,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    await tick();
}
/** Is `t` still resting on its step (its wait not over)? */
const resting = (t: number) => {
    const s = ownFreshSteps("worker", [t]).get(t);
    return !!s && s.restUntil > Date.now();
};

test("a re-park of the awaited ticket, citing no commit, does not wake what waits on it", async () => {
    const a = await held("parked on b");
    const b = await held("the awaited one");
    const c = await held("b waits on it");
    await step(a, { ticket: b });
    assert.equal(resting(a), true);
    const before = lastMoveAt(b);
    await step(b, { ticket: c });
    assert.equal(lastMoveAt(b), before, "b did not move");
    assert.equal(resting(a), true, "a still waits");
    assert.deepEqual(liveResumeOn(a)?.on, b, "and the cycle check still sees the wait");
});

test("a step that cites a commit is a move", async () => {
    const a = await held("parked on b2");
    const b = await held("b2");
    await step(a, { ticket: b });
    await step(b, { timer: 0 }, ["9e32067"]);
    assert.equal(resting(a), false);
    assert.equal(liveResumeOn(a), null);
});

test("a comment from someone else is a move, even with a parking step after it", async () => {
    const a = await held("parked on b3");
    const b = await held("b3");
    const c = await held("b3 waits on it");
    await step(a, { ticket: b });
    submitMessage({ project: P, kind: "comment_added", ticket_id: b, body: "news", by_agent: "boss" });
    await tick();
    await step(b, { ticket: c });
    assert.equal(resting(a), false, "the comment counted, the re-park after it did not hide it");
});

test("a close is a move", async () => {
    const a = await held("parked on b4");
    const b = await held("b4");
    await step(a, { ticket: b });
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: b, by_agent: "boss" });
    await tick();
    assert.equal(resting(a), false);
});

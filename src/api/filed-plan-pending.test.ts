/**
 * #4609 — a plan attached at ticket creation reads pending on ticket.list as on
 * ticket.get, until the thread carries a decision of its own.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-4609-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "4609-h" }).token;
const P = "p-4609";
createProject({ name: P });

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function filedWithPlan(title: string): number {
    const id = submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "worker", decision_kind: "plan" }).id;
    updateMessageStatus(id, "approved", "human", null, "ticket_created");
    return id;
}
async function pending(id: number): Promise<boolean | undefined> {
    const r = await asToken<{ id: number; pending_decision: boolean }[]>(HUMAN, "ticket.list", { project: P, status: "any" });
    assert.equal(r.status, 200);
    return r.json.find((t) => t.id === id)?.pending_decision;
}
const comment = (ticket: number, by: string, extra: Record<string, unknown> = {}) =>
    submitMessage({ project: P, kind: "comment_added", ticket_id: ticket, body: "c", by_agent: by, summary_until: "s", commits: null, ...extra });

test("a plan filed with the ticket reads pending, with no comment", async () => {
    assert.equal(await pending(filedWithPlan("no comment")), true);
});

test("plain comments do not change what the list says, even a human's", async () => {
    const id = filedWithPlan("plain comments");
    comment(id, "worker");
    comment(id, "boss");
    assert.equal(await pending(id), true);
});

test("a decision in the thread replaces it: its outcome is what the list says", async () => {
    const id = filedWithPlan("replaced");
    const c = comment(id, "worker", { decision_kind: "plan" });
    updateMessageStatus(c.id, "approved", "human", null, "comment_added");
    assert.equal(await pending(id), true, "the newer plan is pending");
    const r = await asToken(HUMAN, "message.decide", { id: c.id, status: "accepted" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await pending(id), false, "accepted, though the filed plan's own meta still reads pending");
});

test("an accepted filed plan no longer reads pending", async () => {
    const id = filedWithPlan("accepted");
    const r = await asToken(HUMAN, "message.decide", { id, status: "accepted" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await pending(id), false);
});

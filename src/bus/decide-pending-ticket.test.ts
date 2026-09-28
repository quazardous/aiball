// #3195 — a proposal is decided only on a ticket the moderator approved, as one is posted only there.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aiball-3195-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { getMethod } = await import("./methods.js");
await import("./register.js");
const { ensureConsumer, getMessage } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");
after(() => rmSync(home, { recursive: true, force: true }));

ensureConsumer("boss");
ensureConsumer("worker");
createProject({ name: "p-3195" });
const boss = { consumer_id: "boss", kind: "human", transport: "uds", relayed: false, token: null } as never;
const decide = getMethod("message.decide")!;
const acceptAndClose = getMethod("message.accept_and_close")!;

/** A ticket filed with its plan, left waiting for moderation. */
function pendingTicketWithPlan(): number {
    const t = submitMessage({ project: "p-3195", kind: "ticket_created", title: "T", body: "b", decision_kind: "plan", by_agent: "worker" } as never);
    updateMessageStatus(t.id, "pending", "human", null, "ticket_created");
    return t.id;
}

function refused(f: () => unknown): { status: number; code?: string; message: string } {
    try { f(); } catch (e) { return e as { status: number; code?: string; message: string }; }
    return assert.fail("not refused");
}

test("a plan on a ticket still waiting for moderation: neither accepted nor rejected", () => {
    const t = pendingTicketWithPlan();
    for (const status of ["accepted", "rejected"]) {
        const r = refused(() => decide.run(boss, { id: t, status }));
        assert.equal(r.status, 409, status);
        assert.equal(r.code, "PARENT_PENDING_MODERATION");
        assert.match(r.message, /approve the ticket first \(it is pending\)/);
    }
    assert.match(String(getMessage(t)?.meta), /"status":"pending"/, "the plan is untouched");
});

test("once the ticket is approved, its plan is decided", () => {
    const t = pendingTicketWithPlan();
    updateMessageStatus(t, "approved", "human", null, "ticket_created");
    decide.run(boss, { id: t, status: "accepted" });
    assert.match(String(getMessage(t)?.meta), /"status":"accepted"/);
});

test("a proposal on a comment of a pending ticket, and accept_and_close, are refused too", () => {
    const t = submitMessage({ project: "p-3195", kind: "ticket_created", title: "T2", body: "b", by_agent: "boss" } as never).id;
    updateMessageStatus(t, "approved", "human", null, "ticket_created"); // a proposal is posted only on an approved ticket
    const c = submitMessage({ project: "p-3195", kind: "comment_added", ticket_id: t, parent_id: t, body: "done", decision_kind: "resolution", summary_until: "s", commits: null, by_agent: "worker" } as never).id;
    updateMessageStatus(t, "pending", "human", null, "ticket_created");
    assert.equal(refused(() => decide.run(boss, { id: c, status: "accepted" })).code, "PARENT_PENDING_MODERATION");
    updateMessageStatus(c, "pending", "human", null, "comment_added");
    assert.equal(refused(() => acceptAndClose.run(boss, { id: c })).code, "PARENT_PENDING_MODERATION");
});

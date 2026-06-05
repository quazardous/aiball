/**
 * #737 — escalation primitive : at-insert side-effect is a priority bump on
 * the parent ticket (low/normal→high, high→urgent, urgent stays). Mirrors
 * the messages-decision-guard.test.ts setup style (throwaway DB pointed
 * via AIBALL_HOME before imports).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-737-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject } = await import("./db/projects.js");
const { getMessage, updateMessageStatus } = await import("./db/messages.js");

getDb();
createProject({ name: "p737" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent" });
upsertConsumer({ consumer_id: "david", kind: "human" });

/** Create an approved ticket at the given priority so we can probe the
 *  bump behaviour from each starting priority. Reporter is human so the
 *  ticket lands approved directly (no moderation step). */
function freshApprovedTicket(priority: "low" | "normal" | "high" | "urgent"): number {
    const t = submitMessage({
        project: "p737",
        kind: "ticket_created",
        title: `t-${priority}`,
        body: "test fixture",
        by_agent: "david",
        priority,
    });
    if (t.status !== "approved") {
        updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    }
    return t.id;
}

function priorityOf(ticketId: number): string {
    const m = getMessage(ticketId);
    return m?.priority ?? "normal";
}

test("#737 — escalation on a normal ticket bumps to high", () => {
    const tid = freshApprovedTicket("normal");
    submitMessage({
        project: "p737",
        kind: "comment_added",
        ticket_id: tid,
        body: "needs admin action",
        decision_kind: "escalation",
        summary_until: "escalated to david",
        by_agent: "agent-x",
    });
    assert.equal(priorityOf(tid), "high");
});

test("#737 — escalation on a low ticket bumps to high", () => {
    const tid = freshApprovedTicket("low");
    submitMessage({
        project: "p737",
        kind: "comment_added",
        ticket_id: tid,
        body: "still needs admin",
        decision_kind: "escalation",
        summary_until: "escalated",
        by_agent: "agent-x",
    });
    assert.equal(priorityOf(tid), "high");
});

test("#737 — escalation on a high ticket bumps to urgent", () => {
    const tid = freshApprovedTicket("high");
    submitMessage({
        project: "p737",
        kind: "comment_added",
        ticket_id: tid,
        body: "now critical",
        decision_kind: "escalation",
        summary_until: "escalated to urgent",
        by_agent: "agent-x",
    });
    assert.equal(priorityOf(tid), "urgent");
});

test("#737 — escalation on an urgent ticket is a no-op (idempotent at the top)", () => {
    const tid = freshApprovedTicket("urgent");
    submitMessage({
        project: "p737",
        kind: "comment_added",
        ticket_id: tid,
        body: "second escalation",
        decision_kind: "escalation",
        summary_until: "stays urgent",
        by_agent: "agent-x",
    });
    assert.equal(priorityOf(tid), "urgent");
});

test("#737 — plain comment (no decision_kind) does NOT touch priority", () => {
    const tid = freshApprovedTicket("normal");
    submitMessage({
        project: "p737",
        kind: "comment_added",
        ticket_id: tid,
        body: "just a comment",
        summary_until: "no decision",
        by_agent: "agent-x",
    });
    assert.equal(priorityOf(tid), "normal");
});

test("#737 — resolution / plan / wontfix do NOT touch priority (only escalation)", () => {
    for (const kind of ["resolution", "plan", "wontfix"] as const) {
        const tid = freshApprovedTicket("normal");
        submitMessage({
            project: "p737",
            kind: "comment_added",
            ticket_id: tid,
            body: `${kind} proposal`,
            decision_kind: kind,
            summary_until: `${kind} state`,
            by_agent: "agent-x",
        });
        assert.equal(priorityOf(tid), "normal", `${kind} should not bump priority`);
    }
});

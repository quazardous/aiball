/**
 * #830 david `a7pn65` — after a /decide flips a decision's status, the
 * handler emits a dedicated event of kind `<decisionKind>_<status>` so the
 * wake-injection pipeline routes it through a dedicated template branch
 * (instead of re-pulling the unchanged original proposal body).
 *
 * These tests cover the end-to-end behaviour at the submitMessage layer
 * (= what /decide ultimately calls). The HTTP route + wake template are
 * exercised by tighter unit tests at their own layers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-830-"));

const { getDb } = await import("./db/connection.js");
const { submitMessage, isDecisionEventKind } = await import("./messages.js");
const { upsertConsumer } = await import("./db/consumers.js");
const { createProject } = await import("./db/projects.js");
const { applyMessageDecision, updateMessageStatus, getMessage, listMessages } = await import("./db/messages.js");

getDb();
createProject({ name: "p830" });
upsertConsumer({ consumer_id: "david", kind: "human" });
upsertConsumer({ consumer_id: "agent-x", kind: "agent" });

/** Approved ticket fixture (human reporter so it skips moderation). */
function freshApprovedTicket(): number {
    const t = submitMessage({
        project: "p830",
        kind: "ticket_created",
        title: "fixture",
        body: "test",
        by_agent: "david",
    });
    if (t.status !== "approved") {
        updateMessageStatus(t.id, "approved", "human", null, "ticket_created");
    }
    return t.id;
}

/** Mirror what the /decide HTTP route does : apply the decision, then
 *  (when meta carries a decision kind + the new status is terminal)
 *  insert the synthetic event. */
function decideAndEmitEvent(messageId: number, status: "accepted" | "rejected", by: string): void {
    const updated = applyMessageDecision(messageId, status, by);
    if (!updated || !updated.meta || updated.ticket_id == null) return;
    const m = JSON.parse(updated.meta) as { decision?: { kind?: string } };
    const decisionKind = m.decision?.kind;
    const eventKindStr = decisionKind ? `${decisionKind}_${status}` : "";
    if (eventKindStr && isDecisionEventKind(eventKindStr)) {
        submitMessage({
            project: updated.project,
            kind: eventKindStr as never,
            ticket_id: updated.ticket_id,
            parent_id: updated.id,
            body: null,
            by_agent: by,
        });
    }
}

function findEvent(ticketId: number, kind: string): { id: number; by_agent: string | null; parent_id: number | null } | null {
    const all = listMessages({ project: "p830", kind: kind as never });
    const hit = all.find((m) => m.ticket_id === ticketId);
    if (!hit) return null;
    // parent_id = m.parentMessageId ?? m.ticketId (per messageRowToMessage) ;
    // for our events parentMessageId is the original proposal id, distinct
    // from the ticket_id.
    return { id: hit.id, by_agent: hit.by_agent, parent_id: hit.parent_id };
}

test("#830 — accepting a plan emits a plan_accepted event linked to the proposal", () => {
    const tid = freshApprovedTicket();
    const proposal = submitMessage({
        project: "p830",
        kind: "comment_added",
        ticket_id: tid,
        body: "here is my plan",
        decision_kind: "plan",
        summary_until: "plan posed",
        by_agent: "agent-x",
    });
    decideAndEmitEvent(proposal.id, "accepted", "david");
    const ev = findEvent(tid, "plan_accepted");
    assert.ok(ev, "plan_accepted event should exist");
    assert.equal(ev!.by_agent, "david", "by_agent = the decider");
    assert.equal(ev!.parent_id, proposal.id, "parent links to the proposal");
});

test("#830 — rejecting a resolution emits a resolution_rejected event", () => {
    const tid = freshApprovedTicket();
    const proposal = submitMessage({
        project: "p830",
        kind: "comment_added",
        ticket_id: tid,
        body: "shipped",
        decision_kind: "resolution",
        summary_until: "done",
        by_agent: "agent-x",
    });
    decideAndEmitEvent(proposal.id, "rejected", "david");
    const ev = findEvent(tid, "resolution_rejected");
    assert.ok(ev, "resolution_rejected event should exist");
    assert.equal(ev!.parent_id, proposal.id);
});

test("#830 — wontfix accept emits wontfix_accepted (independent of the existing auto-close)", () => {
    const tid = freshApprovedTicket();
    const proposal = submitMessage({
        project: "p830",
        kind: "comment_added",
        ticket_id: tid,
        body: "junk",
        decision_kind: "wontfix",
        summary_until: "wontfix posed",
        by_agent: "agent-x",
    });
    decideAndEmitEvent(proposal.id, "accepted", "david");
    const ev = findEvent(tid, "wontfix_accepted");
    assert.ok(ev, "wontfix_accepted event should exist");
});

test("#830 — escalation accept emits escalation_accepted (no auto-close, agent re-engages)", () => {
    const tid = freshApprovedTicket();
    const proposal = submitMessage({
        project: "p830",
        kind: "comment_added",
        ticket_id: tid,
        body: "needs admin",
        decision_kind: "escalation",
        summary_until: "escalated",
        by_agent: "agent-x",
    });
    decideAndEmitEvent(proposal.id, "accepted", "david");
    const ev = findEvent(tid, "escalation_accepted");
    assert.ok(ev, "escalation_accepted event should exist");
});

test("#830 — isDecisionEventKind narrows the 8 kinds", () => {
    for (const k of [
        "plan_accepted", "plan_rejected",
        "resolution_accepted", "resolution_rejected",
        "wontfix_accepted", "wontfix_rejected",
        "escalation_accepted", "escalation_rejected",
    ]) {
        assert.equal(isDecisionEventKind(k), true, `${k} should be a decision-event kind`);
    }
    for (const k of ["comment_added", "ticket_closed", "ticket_resolved", "ticket_created"]) {
        assert.equal(isDecisionEventKind(k), false, `${k} should NOT be a decision-event kind`);
    }
});

test("#830 — proposal's meta.decision.status still flips authoritatively (event is sidecar, not replacement)", () => {
    const tid = freshApprovedTicket();
    const proposal = submitMessage({
        project: "p830",
        kind: "comment_added",
        ticket_id: tid,
        body: "plan",
        decision_kind: "plan",
        summary_until: "plan",
        by_agent: "agent-x",
    });
    decideAndEmitEvent(proposal.id, "accepted", "david");
    const updated = getMessage(proposal.id);
    assert.ok(updated, "proposal still exists");
    const meta = JSON.parse(updated!.meta ?? "{}") as { decision?: { status?: string } };
    assert.equal(meta.decision?.status, "accepted", "meta.decision.status flipped to accepted");
});

// #358 — recency-aware decision gate. node:test + tsx (zero deps).
// Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDecisionGate, computeDecisionGateProposers, type DecisionGateEvent } from "./decision-gate.js";

// Humans in the test set: david. Everyone else = agent.
const isHuman = (id: string) => id === "david";

// Small builder: events are consumed in array order (= id asc order).
// Only what matters for each case is filled in.
type Ev = Partial<DecisionGateEvent> & { kind: string };
function ev(e: Ev): DecisionGateEvent {
    return {
        ticketId: e.ticketId ?? 1,
        kind: e.kind,
        status: e.status ?? "approved",
        meta: e.meta ?? null,
        byAgent: e.byAgent ?? "claude-aiball-dev",
    };
}
function decision(kind: "plan" | "resolution" | "wontfix" | "escalation", status: string): string {
    return JSON.stringify({ decision: { kind, status } });
}
const gate = (events: DecisionGateEvent[]) => computeDecisionGate(events, isHuman);

test("plan pending → gated", () => {
    const g = gate([ev({ kind: "comment_added", meta: decision("plan", "pending") })]);
    assert.equal(g.get(1), true);
});

test("#1113: plan pending + later foreign HUMAN comment → un-gated", () => {
    // Reverses case #600: the human spoke again instead of accepting/
    // rejecting → the proposal is moot, the ball goes back to the agent.
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "david" }), // plain human foreign
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: plan pending + comment by the PROPOSER (same agent) → stays gated", () => {
    // #600 kept for the proposer itself: talking to itself does not bring
    // the ball back to the backlog (still waiting on the other side).
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev" }), // same agent
    ]);
    assert.equal(g.get(1), true);
});

// #2376 david (a6zkyf) — reverses case #1113 for AGENTS: only a human
// speaking hands the ball back, because only that answers the pending
// decision. Another agent commenting decides nothing, the gate holds.
test("#2376: plan pending + comment by a THIRD-PARTY AGENT → stays gated", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "autre-agent" }), // foreign agent
    ]);
    assert.equal(g.get(1), true);
});

test("#2376: a human comment, though, hands the ball back to the agent", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: proposer summary_until (meta without decision) after pending → stays gated", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "claude-aiball-dev", meta: JSON.stringify({ summary_until: "x" }) }),
    ]);
    assert.equal(g.get(1), true);
});

test("#1113: resolution pending + later foreign human comment → un-gated", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "pending") }), // proposer=claude-aiball-dev
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: skybot regression #1109 — resolution pending then plain exchange (david Q / agent A / david Q) → un-gated", () => {
    const g = gate([
        ev({ kind: "comment_added", byAgent: "skybot-claude", meta: decision("resolution", "pending") }),
        ev({ kind: "comment_added", byAgent: "david" }),          // "which key?"
        ev({ kind: "comment_added", byAgent: "skybot-claude" }),  // answer
        ev({ kind: "comment_added", byAgent: "david" }),          // new question
    ]);
    assert.equal(g.get(1), false);
});

test("#1113: foreign comment BEFORE any pending decision → no spurious un-gate (stays gated after pending)", () => {
    const g = gate([
        ev({ kind: "comment_added", byAgent: "david" }),          // no gate yet
        ev({ kind: "comment_added", byAgent: "skybot-claude", meta: decision("resolution", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("resolution ACCEPTED + later human comment → stays gated (settled, no implicit reopen)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "accepted") }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(g.get(1), true);
});

test("plan accepted = go-signal → un-gated", () => {
    const g = gate([ev({ kind: "comment_added", meta: decision("plan", "accepted") })]);
    assert.equal(g.get(1), false);
});

test("plan / resolution rejected → un-gated", () => {
    assert.equal(gate([ev({ kind: "comment_added", meta: decision("plan", "rejected") })]).get(1), false);
    assert.equal(gate([ev({ kind: "comment_added", meta: decision("resolution", "rejected") })]).get(1), false);
});

test("#600 v7z5u6: legacy ticket_resolved (pending OR approved) + human comment → stays gated", () => {
    const pending = gate([
        ev({ kind: "ticket_resolved", status: "pending" }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(pending.get(1), true);
    const approved = gate([
        ev({ kind: "ticket_resolved", status: "approved" }),
        ev({ kind: "comment_added", byAgent: "david" }),
    ]);
    assert.equal(approved.get(1), true);
});

test("#802: wontfix pending → gated (mirrors resolution)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#802: wontfix accepted → stays gated (the ticket is closed separately, not in the gate)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "accepted") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#802: wontfix rejected → un-gated (reporter says no, the ticket stays open)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("wontfix", "pending") }),
        ev({ kind: "comment_added", meta: decision("wontfix", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#737: escalation pending → gated (agent waits for the human action)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#737: escalation accepted = human did the action → un-gated (no auto-close, the agent can carry on)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
        ev({ kind: "comment_added", meta: decision("escalation", "accepted") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#737: escalation rejected = not an escalation → un-gated (agent can re-classify)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("escalation", "pending") }),
        ev({ kind: "comment_added", meta: decision("escalation", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("ticket_reopened (approved) un-gates even after a resolution", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("resolution", "accepted") }),
        ev({ kind: "ticket_reopened", status: "approved" }),
    ]);
    assert.equal(g.get(1), false);
});

test("#600 v7z5u6: last-signal-wins: pending → reject (un-gate) → new pending proposal (re-gate)", () => {
    const g = gate([
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "rejected") }),
        ev({ kind: "comment_added", meta: decision("plan", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("human comment with no prior gate → no entry (not gated)", () => {
    const g = gate([ev({ kind: "comment_added", byAgent: "david" })]);
    assert.equal(g.get(1), undefined);
});

test("pending decision not approved (moderation waiting) → ignored", () => {
    const g = gate([ev({ kind: "comment_added", status: "pending", meta: decision("plan", "pending") })]);
    assert.equal(g.get(1), undefined);
});

test("#803: ticket_created with pending plan → gated", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
    ]);
    assert.equal(g.get(1), true);
});

test("#803: ticket_created with accepted plan → un-gated (go-signal)", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "accepted") }),
    ]);
    assert.equal(g.get(1), false);
});

test("#803: ticket_created with rejected plan → un-gated (re-plan)", () => {
    const g = gate([
        ev({ kind: "ticket_created", meta: decision("plan", "pending") }),
        ev({ kind: "comment_added", meta: decision("plan", "rejected") }),
    ]);
    assert.equal(g.get(1), false);
});

test("independent tickets do not mix", () => {
    const g = gate([
        ev({ ticketId: 1, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "pending") }),
        ev({ ticketId: 2, kind: "comment_added", meta: decision("plan", "accepted") }), // un-gates #2 only
    ]);
    assert.equal(g.get(1), true);
    assert.equal(g.get(2), false);
});

test("#2649 the proposer of a pending gate is named; a settled or lifted gate names nobody", () => {
    const ev = (o: Partial<DecisionGateEvent>): DecisionGateEvent => ({ ticketId: 1, kind: "comment_added", status: "approved", meta: null, byAgent: "a", ...o });
    const plan = (by: string, status = "pending") => ev({ byAgent: by, meta: JSON.stringify({ decision: { kind: "plan", status } }) });
    assert.equal(computeDecisionGateProposers([plan("agent-a")], isHuman).get(1), "agent-a");
    assert.equal(computeDecisionGateProposers([plan("agent-a"), ev({ byAgent: "agent-b" })], isHuman).get(1), "agent-a", "another agent speaking keeps the gate and its proposer");
    assert.equal(computeDecisionGateProposers([plan("agent-a"), plan("agent-b")], isHuman).get(1), "agent-b", "the latest proposal wins");
    assert.equal(computeDecisionGateProposers([plan("agent-a"), ev({ byAgent: "david" })], isHuman).has(1), false, "a human speaking lifts it");
    const resolution = ev({ byAgent: "agent-a", meta: JSON.stringify({ decision: { kind: "resolution", status: "accepted" } }) });
    assert.equal(computeDecisionGateProposers([resolution], isHuman).has(1), false, "a settled gate has no proposer");
});

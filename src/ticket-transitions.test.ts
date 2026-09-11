/**
 * #2308 — the transition table is the one place a decision's behaviour is
 * defined. What must hold:
 * - every kind has its row, and the two families split the kinds between them;
 * - the gate replay follows a truth table written HERE, by hand. A test that
 *   read its expectations back from the table would prove nothing;
 * - posting honours `allowedOn`, each `then` verb maps to its kind, and the
 *   post-time effects sit where the table says;
 * - the matrix in docs/TICKET_LIFECYCLE.md is exactly what the table renders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2308-"));
process.env.AIBALL_SOCK = "";

const t = await import("./ticket-transitions.js");
const { computeDecisionGate } = await import("./db/decision-gate.js");
const { CLOSING_DECISION_KINDS, WAITING_DECISION_KINDS } = await import("./decisions.js");
const { validateNewMessage } = await import("./messages.js");

type Kind = typeof t.DECISION_KINDS[number];
type Scenario =
    | "pending"
    | "pending, then someone else comments"
    | "pending, then the proposer comments"
    | "accepted"
    | "accepted, then someone else comments"
    | "rejected";

// Is the ticket gated at the end of each scenario? Written by hand; typed as a
// Record over the kinds, so a new kind does not typecheck until its expected
// behaviour is written down here.
const EXPECTED: Record<Kind, Record<Scenario, boolean>> = {
    plan: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": false, "accepted, then someone else comments": false, "rejected": false,
    },
    resolution: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": true, "accepted, then someone else comments": true, "rejected": false,
    },
    wontfix: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": true, "accepted, then someone else comments": true, "rejected": false,
    },
    escalation: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": false, "accepted, then someone else comments": false, "rejected": false,
    },
};

const decided = (kind: string, status: string) => ({
    ticketId: 1, kind: "comment_added", status: "approved",
    meta: JSON.stringify({ decision: { kind, status } }), byAgent: "agent",
});
const plain = (by: string) => ({ ticketId: 1, kind: "comment_added", status: "approved", meta: null, byAgent: by });

function scenario(kind: string, s: Scenario) {
    switch (s) {
        case "pending": return [decided(kind, "pending")];
        case "pending, then someone else comments": return [decided(kind, "pending"), plain("david")];
        case "pending, then the proposer comments": return [decided(kind, "pending"), plain("agent")];
        case "accepted": return [decided(kind, "accepted")];
        case "accepted, then someone else comments": return [decided(kind, "accepted"), plain("david")];
        case "rejected": return [decided(kind, "pending"), decided(kind, "rejected")];
    }
}

test("every decision kind has its row and its expected behaviour, and the two families split the kinds", () => {
    assert.deepEqual(Object.keys(t.DECISION_GESTURES), [...t.DECISION_KINDS]);
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...t.DECISION_KINDS].sort());
    const closing = [...CLOSING_DECISION_KINDS];
    const waiting = [...WAITING_DECISION_KINDS];
    assert.deepEqual([...closing, ...waiting].sort(), [...t.DECISION_KINDS].sort());
    assert.equal(closing.filter((k) => waiting.includes(k)).length, 0);
});

test("the gate replay follows the truth table, kind by kind and scenario by scenario", () => {
    for (const kind of t.DECISION_KINDS) {
        for (const [s, gated] of Object.entries(EXPECTED[kind]) as [Scenario, boolean][]) {
            assert.equal(computeDecisionGate(scenario(kind, s), () => false).get(1), gated, `${kind}: ${s}`);
        }
    }
    assert.equal(t.gateEffect("nope", "pending"), null, "an unknown kind is inert");
    assert.equal(t.gateEffect("plan", "weird"), null, "an unknown status is inert");
});

test("a decision is accepted where the table allows it and refused elsewhere, with the reason", () => {
    for (const kind of t.DECISION_KINDS) {
        const onComment = validateNewMessage({ project: "p", kind: "comment_added", ticket_id: 1, body: "b", decision_kind: kind });
        assert.ok(!("error" in onComment && /decision_kind/.test(String(onComment.error))), `${kind} on a comment`);
        const onTicket = validateNewMessage({ project: "p", kind: "ticket_created", title: "t", body: "b", decision_kind: kind });
        if (kind === "plan") {
            assert.ok(!("error" in onTicket), "a plan may ride on a new ticket");
        } else {
            assert.match(String((onTicket as { error?: string }).error), /decision_kind on ticket_created must be "plan"/, kind);
        }
    }
});

test("each then verb posts its kind, and only escalation acts when posted", () => {
    assert.equal(t.kindForVerb("resolved"), "resolution");
    assert.equal(t.kindForVerb("escalate"), "escalation");
    assert.equal(t.kindForVerb("close"), null);
    assert.deepEqual(t.verbsAllowedOn("ticket_created"), ["plan"]);
    assert.deepEqual(t.verbsAllowedOn("comment_added"), ["plan", "resolved", "wontfix", "escalate"]);
    for (const kind of t.DECISION_KINDS) {
        const { bumpPriority, broadcast } = t.DECISION_GESTURES[kind].onPost;
        assert.equal(bumpPriority, kind === "escalation", `${kind} priority bump`);
        assert.equal(broadcast, kind === "escalation", `${kind} broadcast`);
    }
});

test("the lifecycle doc's decision matrix is exactly what the table renders", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "TICKET_LIFECYCLE.md"), "utf8");
    assert.equal(t.withDecisionMatrix(doc), doc, "out of date — run: npx tsx scripts/gen-transition-matrix.ts");
});

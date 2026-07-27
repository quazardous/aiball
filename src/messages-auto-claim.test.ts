/**
 * #1584 — the auto-claim's intent signal.
 *
 * `carriesDecision` is what decides whether posting on a ticket takes it. The
 * two incidents it closes: a lead reviewing another agent's ticket confiscated
 * it while writing "this stays yours", and could not announce handing it back
 * because the announcement re-claimed it.
 *
 * Run: `npx tsx --test src/messages-auto-claim.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { carriesDecision } from "./messages.js";
import { DECISION_KINDS } from "./decisions.js";

test("every decision kind claims — an agent that works a ticket always posts one", () => {
    // Derived from DECISION_KINDS rather than typed out: a new verb must not
    // ship silently unable to claim.
    for (const kind of DECISION_KINDS) {
        assert.equal(
            carriesDecision(JSON.stringify({ decision: { kind, status: "pending" } })),
            true,
            `${kind} should claim`,
        );
    }
});

test("a bare comment does not claim — questions, reviews, handoffs", () => {
    assert.equal(carriesDecision(null), false);
    assert.equal(carriesDecision(undefined), false);
    assert.equal(carriesDecision(""), false);
    // A comment carrying only a state snapshot is still just a comment.
    assert.equal(carriesDecision(JSON.stringify({ summary_until: "état du ticket" })), false);
});

test("a handoff can be announced: releasing then commenting does not re-take", () => {
    // The second incident, reduced to its cause. The release is undone only if
    // the follow-up comment claims — and a bare comment no longer does.
    const announcement = JSON.stringify({ summary_until: "je relâche, c'est à toi" });
    assert.equal(carriesDecision(announcement), false);
});

test("malformed or foreign meta never grants a claim", () => {
    assert.equal(carriesDecision("{not json"), false);
    assert.equal(carriesDecision(JSON.stringify({ decision: null })), false);
    assert.equal(carriesDecision(JSON.stringify({ decision: {} })), false);
    assert.equal(carriesDecision(JSON.stringify({ decision: { kind: "invented" } })), false);
    assert.equal(carriesDecision(JSON.stringify({ decision: { kind: 42 } })), false);
    // `relation` sidecars share the meta column and must not be mistaken for one.
    assert.equal(carriesDecision(JSON.stringify({ relation: { kind: "child_of" } })), false);
});

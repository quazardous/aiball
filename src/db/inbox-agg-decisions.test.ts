/**
 * #1835 — the inbox's decision detection was NARROWER than the decision model,
 * and the gap failed in the worst direction: silently, and toward "nothing to
 * do".
 *
 * A pending decision GATES a ticket out of the agent's actionable pool. So a
 * kind the inbox ignores yields a ticket that has left the agent's queue and
 * lights nothing for the human. Nobody is looking at it, and no error is
 * raised anywhere. Two such gaps existed: the `wontfix` kind, and any decision
 * filed WITH the ticket rather than on a comment.
 *
 * These pin the model, not the two bugs: a fifth decision kind added later is
 * what the first test catches.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { emptyAgg } from "./inbox-agg.js";
import { DECISION_KINDS } from "../decisions.js";
import { ticketDecision } from "../api/tickets.js";

test("every decision kind the model defines has a pending flag on the aggregate", () => {
    // buildInboxAgg reads the DB, so the shape is what can be pinned purely —
    // and the shape is exactly what was missing: no pendingWontfix field meant
    // no dispatch could ever set one.
    const agg = emptyAgg() as unknown as Record<string, unknown>;
    for (const kind of DECISION_KINDS) {
        const flag = `pending${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
        assert.ok(flag in agg, `decision kind "${kind}" has no "${flag}" on the inbox aggregate`);
    }
});

test("a decision carried by the TICKET is seen, not just one on a comment", () => {
    const t = { meta: JSON.stringify({ decision: { kind: "plan", status: "pending" } }) };
    assert.equal(ticketDecision(t, "plan"), true);
    assert.equal(ticketDecision(t, null), true, "kind=null asks whether any decision is pending");
    assert.equal(ticketDecision(t, "wontfix"), false, "a different kind must not match");
});

test("only a PENDING ticket decision counts", () => {
    for (const status of ["accepted", "rejected"]) {
        const t = { meta: JSON.stringify({ decision: { kind: "plan", status } }) };
        assert.equal(ticketDecision(t, "plan"), false, `status "${status}" must not read as pending`);
    }
});

test("a missing or malformed meta never takes the row down", () => {
    assert.equal(ticketDecision({ meta: null }, null), false);
    assert.equal(ticketDecision({}, null), false);
    assert.equal(ticketDecision({ meta: "not json" }, null), false);
    assert.equal(ticketDecision({ meta: "{}" }, null), false);
});

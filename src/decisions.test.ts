// #295 first battery — pure decision-state-machine logic (#B.129/#B.256).
// node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    applyDecision,
    reclassifyDecision,
    promoteToDecision,
    isDecisionKind,
    isDecisionStatus,
    type CommentDecision,
} from "./decisions.js";

test("isDecisionKind / isDecisionStatus guards", () => {
    assert.ok(isDecisionKind("plan"));
    assert.ok(isDecisionKind("resolution"));
    assert.ok(!isDecisionKind("nope"));
    assert.ok(isDecisionStatus("pending"));
    assert.ok(isDecisionStatus("accepted"));
    assert.ok(!isDecisionStatus("accept"));
});

test("applyDecision: accept a pending decision stamps by/at", () => {
    const r = applyDecision({ kind: "resolution", status: "pending" }, "accepted", "david", "2026-01-01T00:00:00Z");
    assert.equal(r.changed, true);
    assert.deepEqual(r.decision, {
        kind: "resolution",
        status: "accepted",
        decided_by: "david",
        decided_at: "2026-01-01T00:00:00Z",
    });
});

test("applyDecision: reject a pending decision", () => {
    const r = applyDecision({ kind: "plan", status: "pending" }, "rejected", "d", "t");
    assert.equal(r.decision.status, "rejected");
    assert.equal(r.changed, true);
});

test("applyDecision: can reclassify the kind at decision time", () => {
    const r = applyDecision({ kind: "resolution", status: "pending" }, "accepted", "d", "t", "plan");
    assert.equal(r.decision.kind, "plan");
    assert.equal(r.decision.status, "accepted");
});

test("applyDecision: idempotent re-accept (same status+kind) is a no-op", () => {
    const cur: CommentDecision = { kind: "plan", status: "accepted", decided_by: "d", decided_at: "t" };
    const r = applyDecision(cur, "accepted", "someone-else", "later");
    assert.equal(r.changed, false);
    assert.equal(r.decision, cur); // returns the same object untouched
});

test("applyDecision: throws when there is no decision to act on", () => {
    assert.throws(() => applyDecision(undefined, "accepted", "d", "t"), /no decision/);
});

test("applyDecision: cannot reset to pending", () => {
    assert.throws(() => applyDecision({ kind: "plan", status: "pending" }, "pending", "d", "t"), /cannot reset/);
});

test("applyDecision: re-deciding a terminal decision differently throws", () => {
    assert.throws(
        () => applyDecision({ kind: "plan", status: "accepted" }, "rejected", "d", "t"),
        /already accepted/,
    );
});

test("reclassifyDecision: change the kind of a pending decision, stays pending", () => {
    const r = reclassifyDecision({ kind: "resolution", status: "pending" }, "plan");
    assert.equal(r.changed, true);
    assert.equal(r.decision.kind, "plan");
    assert.equal(r.decision.status, "pending");
});

test("reclassifyDecision: same kind is a no-op", () => {
    const cur: CommentDecision = { kind: "plan", status: "pending" };
    assert.equal(reclassifyDecision(cur, "plan").changed, false);
});

test("reclassifyDecision: throws on a terminal or missing decision", () => {
    assert.throws(() => reclassifyDecision({ kind: "plan", status: "accepted" }, "resolution"), /already accepted/);
    assert.throws(() => reclassifyDecision(undefined, "plan"), /no decision/);
});

test("promoteToDecision: tag a plain comment as pending", () => {
    const r = promoteToDecision(undefined, "plan");
    assert.deepEqual(r.decision, { kind: "plan", status: "pending" });
    assert.equal(r.changed, true);
});

test("promoteToDecision: tag + accept a plain comment in one shot", () => {
    const r = promoteToDecision(undefined, "resolution", "accepted", "david", "t");
    assert.deepEqual(r.decision, { kind: "resolution", status: "accepted", decided_by: "david", decided_at: "t" });
});

test("promoteToDecision: status= without by/at throws", () => {
    assert.throws(() => promoteToDecision(undefined, "plan", "accepted"), /requires `by` and `at`/);
});

test("promoteToDecision: existing pending decision + no status → reclassify", () => {
    const r = promoteToDecision({ kind: "plan", status: "pending" }, "resolution");
    assert.equal(r.decision.kind, "resolution");
    assert.equal(r.decision.status, "pending");
});

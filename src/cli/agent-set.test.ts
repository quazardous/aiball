// #2180 — `aiball agent set` validates before it sends anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planAgentSet } from "./consumer.js";

test("--type and --can-claim become exactly the patch sent", () => {
    assert.deepEqual(planAgentSet({ type: "cto" }), { kind: "go", patch: { agent_type: "cto" } });
    assert.deepEqual(planAgentSet({ type: "coder", canClaim: "false" }), { kind: "go", patch: { agent_type: "coder", can_claim: false } });
});

test("an unknown type or a non-boolean can-claim is refused", () => {
    assert.equal(planAgentSet({ type: "lead" }).kind, "bad");
    assert.equal(planAgentSet({ canClaim: "yes" }).kind, "bad");
});

test("nothing to set is refused rather than sent", () => {
    assert.equal(planAgentSet({}).kind, "bad");
});

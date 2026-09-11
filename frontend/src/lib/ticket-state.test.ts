// #2327 — the list icon of a ticket whose last word is a step (then: continue):
// a discreet blue check, shown only when nothing that asks for someone applies.
import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleStage } from "./ticket-state";
import type { InboxRow } from "./api";

const row = (over: Partial<InboxRow>): InboxRow => ({ id: 1, status: "approved", closed: false, ...over }) as InboxRow;

test("a step as the last word shows the step icon", () => {
    assert.equal(lifecycleStage(row({ latest_is_step: true })), "step");
});

test("what asks for someone, or a stalled step, wins over the step icon", () => {
    assert.equal(lifecycleStage(row({ latest_is_step: true, pending_plan: true })), "pending-plan");
    assert.equal(lifecycleStage(row({ latest_is_step: true, stalled_step: true })), "stalled-step");
});

test("no step as the last word, the ordinary open icon", () => {
    assert.equal(lifecycleStage(row({})), "open");
});

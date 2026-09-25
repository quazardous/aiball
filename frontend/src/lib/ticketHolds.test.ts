// #3006 — the header shows a claim only while it holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { headerHolds } from "./ticketHolds";

test("a live claim shows, an expired one does not", () => {
    assert.deepEqual(headerHolds({ claimant: "agent", is_claim: true }), { claimant: "agent", assignee: null });
    assert.deepEqual(headerHolds({ claimant: "agent", is_claim: false }), { claimant: null, assignee: null });
});

test("an assignee whose claim expired still shows as the assignee", () => {
    assert.deepEqual(headerHolds({ claimant: "agent", is_claim: false, assignee: "agent" }), { claimant: null, assignee: "agent" });
    assert.deepEqual(headerHolds({ claimant: "agent", is_claim: true, assignee: "agent" }), { claimant: "agent", assignee: null }, "one chip says both");
    assert.deepEqual(headerHolds({ claimant: "a", is_claim: true, assignee: "b" }), { claimant: "a", assignee: "b" });
});

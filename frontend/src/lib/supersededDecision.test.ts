// #3006 — a pending decision replaced by a newer one reads as superseded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { latestDecisionRef, supersedingDecision } from "./decisions";
import type { Message, TicketSummary } from "./api";

const c = (id: number, kind: string, status: string, hashid = `h${id}`) =>
    ({ id, kind: "comment_added", status: "approved", hashid, meta: JSON.stringify({ decision: { kind, status } }) }) as unknown as Message;
const plain = (id: number) => ({ id, kind: "comment_added", status: "approved", meta: null }) as unknown as Message;

test("a pending plan followed by a newer resolution is superseded by it", () => {
    const plan = c(10, "plan", "pending");
    const res = c(12, "resolution", "pending");
    const latest = latestDecisionRef(null, [plan, plain(11), res]);
    assert.deepEqual(latest, { id: 12, kind: "resolution", hashid: "h12" });
    assert.deepEqual(supersedingDecision(plan, latest), latest);
    assert.equal(supersedingDecision(res, latest), null, "the latest is live, not superseded");
});

test("a newer decision already settled still supersedes an older pending one", () => {
    const plan = c(10, "plan", "pending");
    const accepted = c(12, "plan", "accepted");
    assert.deepEqual(supersedingDecision(plan, latestDecisionRef(null, [plan, accepted]))?.id, 12);
});

test("settled decisions keep their own chip; a decision filed with the ticket is superseded by the thread's", () => {
    const rejected = c(10, "plan", "rejected");
    const newer = c(12, "plan", "pending");
    assert.equal(supersedingDecision(rejected, latestDecisionRef(null, [rejected, newer])), null);
    const ticket = { id: 5, status: "approved", meta: JSON.stringify({ decision: { kind: "plan", status: "pending" } }) } as unknown as TicketSummary;
    const latest = latestDecisionRef(ticket, [newer]);
    assert.equal(latest?.id, 12);
    assert.deepEqual(supersedingDecision(ticket as unknown as Message, latest)?.id, 12);
});

// #2645 — the consumer pages' wording of the wait credit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditCell, creditTooltip, moveLabel } from "./waitCredit";

const rows = [
    { project: "aiball", balance: 120, earned: 60, spent: 0, refunded: 0 },
    { project: "skybot", balance: 15, earned: 0, spent: 50, refunded: 5 },
];

test("the list cell sums the projects; a human shows a dash, an agent with no movement nothing", () => {
    assert.deepEqual(creditCell(rows), { text: "135 min", sort: 135 });
    assert.deepEqual(creditCell(null), { text: "—", sort: -1 });
    assert.deepEqual(creditCell([]), { text: "", sort: 0 });
});

test("the tooltip gives one line per project", () => {
    assert.equal(creditTooltip(rows), "aiball: 120 min (earned 60, spent 0, refunded 0)\nskybot: 15 min (earned 0, spent 50, refunded 5)");
    assert.match(creditTooltip(null), /human/);
});

test("each movement reads as a sentence, with the ticket, the short SHA, and a capped wait", () => {
    const base = { id: 1, project: "aiball", ticket_id: 2640, ref: null, requested: null, created_at: "2026-09-16T17:00:00Z" };
    assert.equal(moveLabel({ ...base, kind: "earn_resolved", minutes: 30 }), "+30 min — ticket #2640 closed on its accepted resolution");
    assert.equal(moveLabel({ ...base, kind: "earn_wontfix", minutes: 5 }), "+5 min — ticket #2640 closed on its accepted wontfix");
    assert.equal(moveLabel({ ...base, kind: "earn_commit", minutes: 30, ref: "9e32067f2ad96464e413b38f56885d8ffbb94fab" }), "+30 min — commit 9e32067 on #2640");
    assert.equal(moveLabel({ ...base, kind: "spend", minutes: -20, requested: 45 }), "-20 min — wait on #2640 (asked 45)");
    assert.equal(moveLabel({ ...base, kind: "spend", minutes: -20, requested: 20 }), "-20 min — wait on #2640");
    assert.equal(moveLabel({ ...base, kind: "refund", minutes: 12 }), "+12 min — back early on #2640");
});

// #2640 / #2646 — the reply tool says what a step cost, what is left, and how to
// earn more — commits included — in the project's configured amounts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { earnSentence, waitCreditNote } from "./wait-credit-note.js";

const rules = {
    floor: 5, refund: true, resolved: 30, resolved_no_commit: 10, wontfix: 5,
    commit_lines_per_minute: 20, commit_max: 30, commit_max_age_hours: 48, max_commits_per_comment: 20,
};

test("a step says what it waits, what is left, that an early return pays, and how to earn — commits included", () => {
    const n = waitCreditNote({ project: "aiball", balance: 145, refunded: 0, step: { requested: 5, granted: 5, spent: 5 }, rules })!;
    assert.match(n, /^Wait credit on aiball: this step waits 5 min\. 145 min left\./);
    assert.match(n, /Coming back on this ticket before the wait ends gives back what it has not used\./);
    assert.match(n, /accepted resolution \(\+30 min with a commit cited on that ticket, \+10 without\) or wontfix \(\+5\)/);
    assert.match(n, /each commit you cite on a reply as `commits: \["<sha>"\]` \(\+1 min per 20 changed lines, 30 max, at most 48 h old, 20 per comment\)/);
});

test("out of credit: said so, no refund promised for a wait that cost nothing, and the ways to earn", () => {
    const n = waitCreditNote({ project: "p", balance: 0, refunded: 0, step: { requested: 45, granted: 5, spent: 0 }, rules })!;
    assert.match(n, /^You are out of wait credit on p: this step waits 5 min, not the 45 asked\. 0 min left\./);
    assert.doesNotMatch(n, /Coming back/, "the 5 minutes cost nothing: nothing to give back");
    assert.match(n, /Credit comes back when a ticket closes/);
    assert.match(n, /commits: \["<sha>"\]/);
});

test("the amounts are the project's, and refunds off means no promise", () => {
    const custom = { ...rules, refund: false, resolved: 45, resolved_no_commit: 3, wontfix: 1, commit_lines_per_minute: 50, commit_max: 12, commit_max_age_hours: 6, max_commits_per_comment: 2 };
    const n = waitCreditNote({ project: "p", balance: 20, refunded: 0, step: { requested: 10, granted: 10, spent: 10 }, rules: custom })!;
    assert.doesNotMatch(n, /Coming back/);
    assert.match(n, /\+45 min with a commit cited on that ticket, \+3 without\) or wontfix \(\+1\)/);
    assert.match(n, /\+1 min per 50 changed lines, 12 max, at most 6 h old, 2 per comment/);
});

test("refunds and commits are said; nothing to say says nothing; an older daemon without rules still gets the commits hint", () => {
    const n = waitCreditNote({ project: "p", balance: 70, refunded: 12, commits: [{ commit: "abc1234", minutes: 3, reason: null }, { commit: "deadbee", minutes: 0, reason: "older than 48 h" }], rules })!;
    assert.match(n, /12 min given back for coming back early; 3 min earned by your commits; no credit for deadbee \(older than 48 h\)\. 70 min left/);
    assert.equal(waitCreditNote({ project: "p", balance: 60, refunded: 0 }), null);
    assert.equal(waitCreditNote(undefined), null);
    assert.match(earnSentence(undefined), /commits: \["<sha>"\]/);
});

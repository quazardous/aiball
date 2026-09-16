// #2640 — the reply tool says, in one sentence, what a step cost and what is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitCreditNote } from "./wait-credit-note.js";

test("a step says what it waits and what is left", () => {
    assert.equal(
        waitCreditNote({ project: "aiball", balance: 145, refunded: 0, step: { requested: 5, granted: 5, spent: 5 } }),
        "Wait credit on aiball: this step waits 5 min. 145 min left — earn more by closing tickets and citing commits; come back early to get the rest back.",
    );
});

test("a capped step says it was capped", () => {
    assert.match(
        waitCreditNote({ project: "p", balance: 0, refunded: 0, step: { requested: 45, granted: 5, spent: 0 } })!,
        /this step waits 5 min, not the 45 asked: not enough credit\. 0 min left/,
    );
});

test("refunds and commits are said; a plain comment with nothing to say says nothing", () => {
    const n = waitCreditNote({ project: "p", balance: 70, refunded: 12, commits: [{ commit: "abc1234", minutes: 3, reason: null }, { commit: "deadbee", minutes: 0, reason: "older than 48 h" }] })!;
    assert.match(n, /12 min given back for coming back early; 3 min earned by your commits; no credit for deadbee \(older than 48 h\)\. 70 min left/);
    assert.equal(waitCreditNote({ project: "p", balance: 60, refunded: 0 }), null);
    assert.equal(waitCreditNote(undefined), null);
});

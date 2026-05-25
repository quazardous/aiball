// #442 — remote loop-control authz. node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canStopLoop } from "./loop-control.js";

test("canStopLoop: local/direct human moderator → allowed", () => {
    assert.equal(canStopLoop("agent", true).ok, true);
});

test("canStopLoop: a non-human (agent) caller → denied (moderator-only)", () => {
    const v = canStopLoop("agent", false);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /moderator/i);
});

test("canStopLoop: proxy node → denied even when it asserts a human identity", () => {
    // A node token may relay x-aiball-consumer="human" (auth.ts) → callerIsHuman
    // can be true; the tier check must still deny it (anti-DoS).
    const v = canStopLoop("node", true);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /node/i);
});

test("canStopLoop: node + non-human → denied (tier check wins first)", () => {
    assert.equal(canStopLoop("node", false).ok, false);
});

test("canStopLoop: undefined tier + human → allowed (UDS local-trust resolves human)", () => {
    assert.equal(canStopLoop(undefined, true).ok, true);
});

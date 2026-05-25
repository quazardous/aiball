// #442/#451 — remote loop-control authz. node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canControlLoop } from "./loop-control.js";

test("canControlLoop: local/direct human moderator → allowed", () => {
    assert.equal(canControlLoop("agent", true).ok, true);
});

test("canControlLoop: a non-human (agent) caller → denied (moderator-only)", () => {
    const v = canControlLoop("agent", false);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /moderator/i);
});

test("canControlLoop: proxy node → denied even when it asserts a human identity", () => {
    // A node token may relay x-aiball-consumer="human" (auth.ts) → callerIsHuman
    // can be true; the tier check must still deny it (anti-DoS).
    const v = canControlLoop("node", true);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /node/i);
});

test("canControlLoop: node + non-human → denied (tier check wins first)", () => {
    assert.equal(canControlLoop("node", false).ok, false);
});

test("canControlLoop: undefined tier + human → allowed (UDS local-trust resolves human)", () => {
    assert.equal(canControlLoop(undefined, true).ok, true);
});

// #4034 david — "10 s après busy, pour laisser respirer". The Stop is the end
// of the busy: the hook used to wake Claude right there when work waited, a
// second wake path that skipped the breath. The kernel wakes, at turn:settled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const hook = readFileSync(new URL("./stop-hook.ts", import.meta.url), "utf8");
const kernel = readFileSync(new URL("./kernel.ts", import.meta.url), "utf8");

test("the Stop hook types nothing into Claude and builds no wake", () => {
    assert.doesNotMatch(hook, /\.inject\(/);
    assert.doesNotMatch(hook, /buildContextPhrase|checkHasWork/);
});

test("the kernel drains at turn:settled, and at once only when the loop is already settled", () => {
    assert.match(kernel, /turnActor\.on\("turn:settled"[\s\S]*?drainNow\("turn:settled"\)/);
    assert.match(kernel, /matches\(\{ no_turn: "settled" \}\)/);
    // An event, a hold released, a grace ending: each goes through the same check.
    assert.match(kernel, /if \(loopSettled\(\)\) \{[\s\S]*?drainNow\("sse:ping \(settled\)"\)/);
    assert.match(kernel, /if \(!loopSettled\(\)\) \{ log\("afkMachine: afk:cleared — turn:settled drains it/);
    assert.match(kernel, /if \(loopSettled\(\)\) drainNow\("accept-grace-ended"\)/);
});

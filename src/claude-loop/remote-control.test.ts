// #3254 — Claude's Remote Control: the setting, a loop's choice over it, and the flags they make.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteControl, remoteControlFlags, remoteControlPlan } from "./remote-control.js";

test("the setting alone: off adds nothing, on names the session after the agent, a string names it", () => {
    assert.deepEqual(remoteControlPlan(false, undefined, "worker", []), { value: false, args: [] });
    assert.deepEqual(remoteControlPlan(true, undefined, "worker", []), { value: "worker", args: ["--remote-control", "worker"] });
    assert.deepEqual(remoteControlPlan("phone", undefined, "worker", []), { value: "phone", args: ["--remote-control", "phone"] });
});

test("the loop's choice wins over the setting, both ways", () => {
    assert.deepEqual(remoteControlPlan(true, false, "worker", []), { value: false, args: [] });
    assert.deepEqual(remoteControlPlan(false, true, "worker", []), { value: "worker", args: ["--remote-control", "worker"] });
    assert.deepEqual(remoteControlPlan(true, "mine", "worker", []), { value: "mine", args: ["--remote-control", "mine"] });
    assert.deepEqual(remoteControlPlan(false, null, "worker", []), { value: false, args: [] }, "null: no choice, the setting");
});

test("Claude's own args asking for it are left alone, and say what it is", () => {
    assert.deepEqual(remoteControlPlan(false, false, "worker", ["--remote-control", "own"]), { value: "own", args: [] });
    assert.deepEqual(remoteControlPlan(true, undefined, "worker", ["--remote-control"]), { value: true, args: [] });
    assert.deepEqual(remoteControlPlan(true, undefined, "worker", ["--remote-control", "--model", "opus"]), { value: true, args: [] });
    assert.deepEqual(remoteControlPlan(false, undefined, "worker", ["--remote-control=eq"]), { value: "eq", args: [] });
});

test("a config or flag value: booleans, a trimmed name; nothing usable is null", () => {
    assert.equal(parseRemoteControl(true), true);
    assert.equal(parseRemoteControl(false), false);
    assert.equal(parseRemoteControl("  phone "), "phone");
    for (const v of ["", "  ", "--model", 3, null, undefined, {}]) assert.equal(parseRemoteControl(v), null, String(v));
});

test("the flags that say a choice again: none without one", () => {
    assert.deepEqual(remoteControlFlags(undefined), []);
    assert.deepEqual(remoteControlFlags(null), []);
    assert.deepEqual(remoteControlFlags(false), ["--no-remote-control"]);
    assert.deepEqual(remoteControlFlags(true), ["--remote-control"]);
    assert.deepEqual(remoteControlFlags("phone"), ["--remote-control", "phone"]);
});

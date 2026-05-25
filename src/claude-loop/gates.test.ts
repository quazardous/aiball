// #428 — pure tests for the gate-config parser. node:test, no shell/IO (the
// detectors + runGate are I/O and exercised live, not here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGates, BUILTIN_GATES } from "./gates.js";

test("parseGates: non-array → empty", () => {
    assert.deepEqual(parseGates(undefined), []);
    assert.deepEqual(parseGates(null), []);
    assert.deepEqual(parseGates("nope"), []);
    assert.deepEqual(parseGates({}), []);
});

test("parseGates: built-in type, name defaults to the type", () => {
    const g = parseGates([{ type: "unmerged_pr" }]);
    assert.equal(g.length, 1);
    assert.equal(g[0].type, "unmerged_pr");
    assert.equal(g[0].name, "unmerged_pr");
    assert.equal(g[0].blocks, false);
    assert.equal(g[0].cmd, undefined);
});

test("parseGates: unknown built-in type is dropped", () => {
    assert.deepEqual(parseGates([{ type: "does_not_exist" }]), []);
});

test("parseGates: custom cmd, name defaults to 'gate', message kept", () => {
    const g = parseGates([{ cmd: "make preflight", message: "⚠ KO" }]);
    assert.equal(g.length, 1);
    assert.equal(g[0].cmd, "make preflight");
    assert.equal(g[0].message, "⚠ KO");
    assert.equal(g[0].name, "gate");
    assert.equal(g[0].type, undefined);
});

test("parseGates: explicit name + blocks flag honored", () => {
    const g = parseGates([{ name: "pr", type: "unmerged_pr", blocks: true }]);
    assert.equal(g[0].name, "pr");
    assert.equal(g[0].blocks, true);
});

test("parseGates: blocks only true for literal true", () => {
    assert.equal(parseGates([{ cmd: "x", blocks: "yes" }])[0].blocks, false);
    assert.equal(parseGates([{ cmd: "x", blocks: 1 }])[0].blocks, false);
});

test("parseGates: drops entries with neither type nor cmd, keeps valid ones", () => {
    const g = parseGates([
        { name: "noop" }, // no type, no cmd → dropped
        42, // not an object → dropped
        null, // → dropped
        { type: "unmerged_pr" }, // kept
        { cmd: "echo hi" }, // kept
    ]);
    assert.equal(g.length, 2);
    assert.deepEqual(g.map((x) => x.name), ["unmerged_pr", "gate"]);
});

test("parseGates: blank type/cmd strings are treated as absent", () => {
    assert.deepEqual(parseGates([{ type: "   " }]), []);
    assert.deepEqual(parseGates([{ cmd: "  " }]), []);
});

test("BUILTIN_GATES: unmerged_pr exposes a slot + default message", () => {
    const b = BUILTIN_GATES.unmerged_pr;
    assert.equal(b.slot, "gate_unmerged_pr");
    assert.match(b.defaultMessage, /\{count\}/);
    assert.equal(typeof b.detect, "function");
});

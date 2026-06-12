// #428 — pure tests for the gate-config parser. node:test, no shell/IO (the
// detectors + runGate are I/O and exercised live, not here).
//
// #750 Slice 2 — `parseGates` cases (8 entries) migrés vers
// `tests/integration/scenarios/gates-parse.yaml`. La case BUILTIN_GATES
// reste ici (typeof-function check + module-const access non-exprimables
// dans le runner yaml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_GATES } from "./gates.js";

test("BUILTIN_GATES: unmerged_pr exposes a slot + default message", () => {
    const b = BUILTIN_GATES.unmerged_pr;
    assert.equal(b.slot, "gate_unmerged_pr");
    assert.match(b.defaultMessage, /\{count\}/);
    assert.equal(typeof b.detect, "function");
});

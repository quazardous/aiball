// #4874 — a node's readiness to take the board over, as the master's panel shows it.
import test from "node:test";
import assert from "node:assert/strict";
import { nodeSwitchState } from "./nodeSwitch";

test("a connected node whose copy is complete, alone on its master, is ready", () => {
    assert.deepEqual(nodeSwitchState({ switch: { ready: true, reasons: [] } }, true, 0), { ready: true, reasons: [] });
});

test("the node's own reasons come first, then what the master sees", () => {
    const s = nodeSwitchState({ switch: { ready: false, reasons: ["copy not complete"] } }, true, 2);
    assert.equal(s.ready, false);
    assert.deepEqual(s.reasons, ["copy not complete", "2 other nodes are connected to this master: they would lose it"]);
});

test("a node that is gone, keeps no copy, or is too old to say, is not ready", () => {
    assert.match(nodeSwitchState(null, false, 0).reasons[0]!, /not connected/);
    assert.match(nodeSwitchState(null, true, 0).reasons[0]!, /no copy/);
    assert.match(nodeSwitchState({}, true, 0).reasons[0]!, /update it/);
});

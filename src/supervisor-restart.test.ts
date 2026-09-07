// #2089 — the one decision that matters when a daemon restarts itself by
// stopping: is anything going to start it again?
//
// Getting this wrong in the permissive direction does not degrade a feature, it
// turns aiball off until someone notices. So every unclear answer is "no".
import test from "node:test";
import assert from "node:assert/strict";
import { TRAY_HEARTBEAT_STALE_MS, trayIsWatching } from "./supervisor-restart.js";

const NOW = Date.parse("2026-09-07T10:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

test("a fresh heartbeat means the tray will catch us", () => {
    assert.equal(trayIsWatching(at(0), NOW), true);
    assert.equal(trayIsWatching(at(-5_000), NOW), true, "one tick old is normal");
});

test("no heartbeat at all means nobody is watching", () => {
    // The portable / dev case: stopping would just turn aiball off.
    assert.equal(trayIsWatching(null, NOW), false);
    assert.equal(trayIsWatching("", NOW), false);
});

test("a stale heartbeat means the tray is gone", () => {
    assert.equal(trayIsWatching(at(-TRAY_HEARTBEAT_STALE_MS), NOW), false, "stale at the boundary");
    assert.equal(trayIsWatching(at(-TRAY_HEARTBEAT_STALE_MS + 1_000), NOW), true);
});

test("an unreadable heartbeat is a no", () => {
    assert.equal(trayIsWatching("not a date", NOW), false);
    assert.equal(trayIsWatching("   ", NOW), false);
});

test("surrounding whitespace doesn't matter", () => {
    assert.equal(trayIsWatching(`\n  ${at(-1_000)}  \n`, NOW), true);
});

test("a heartbeat far in the future is a no, not a yes forever", () => {
    // A wrong clock on the machine would otherwise hand out a permanent
    // licence to stop the daemon — the same class of mistake that broke
    // pairing, and here it would be silent.
    assert.equal(trayIsWatching(at(2 * 60 * 60_000), NOW), false);
});

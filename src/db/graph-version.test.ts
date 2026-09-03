// #1992 — the staleness rule for the compiled graph.
import test from "node:test";
import assert from "node:assert/strict";
import { needsRecompile, versionDrift, DEFAULT_MIN_DRIFT, type GraphVersion } from "./graph-version.js";

const v = (throughId: number, messageCount = 100, editedCount = 5): GraphVersion =>
    ({ throughId, messageCount, editedCount });

test("never compiled → recompile", () => {
    assert.equal(needsRecompile(v(500), null), true);
    assert.equal(versionDrift(v(500), null), 500);
});

test("nothing moved → don't recompile", () => {
    assert.equal(needsRecompile(v(500), v(500)), false);
    assert.equal(versionDrift(v(500), v(500)), 0);
});

test("an appended message moves max(id) → recompile", () => {
    assert.equal(needsRecompile(v(501), v(500)), true);
    assert.equal(versionDrift(v(501), v(500)), 1);
});

test("a deleted message leaves max(id) alone — the count catches it", () => {
    // The whole reason the version is three integers and not one.
    assert.equal(needsRecompile(v(500, 99), v(500, 100)), true);
});

test("a body edited in place moves only the edited count", () => {
    // An edit can add or remove a `#N`, so it must invalidate the artifact
    // even though neither max(id) nor the row count budges.
    assert.equal(needsRecompile(v(500, 100, 6), v(500, 100, 5)), true);
});

test("a rewound log is never trusted", () => {
    // A restore from backup, or a test DB wiped under a live process: the
    // artifact describes events that no longer exist.
    assert.equal(needsRecompile(v(400), v(500)), true);
    // …and drift is reported as 0 rather than negative, since "behind by -100"
    // is not a thing a caller can act on.
    assert.equal(versionDrift(v(400), v(500)), 0);
});

test("a threshold holds back small drift, but never zero", () => {
    assert.equal(needsRecompile(v(509), v(500), 10), false, "9 events, threshold 10");
    assert.equal(needsRecompile(v(510), v(500), 10), true, "10 events reaches it");
    // A threshold of 0 (or a negative one) must not mean "recompile even when
    // nothing changed" — that would spin.
    assert.equal(needsRecompile(v(500), v(500), 0), false);
    assert.equal(needsRecompile(v(501), v(500), 0), true);
});

test("the default is to recompile on any movement", () => {
    assert.equal(DEFAULT_MIN_DRIFT, 1);
    assert.equal(needsRecompile(v(501), v(500)), true);
});

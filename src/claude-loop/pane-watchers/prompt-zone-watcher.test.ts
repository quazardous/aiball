/**
 * #953 — PromptZoneWatcher tests. node:test, no I/O.
 *
 * Pin la regex structurelle (2 lignes `─{20,}` qui encadrent un `❯`)
 * + transitions begin/end + le helper `findPromptZone` exporté pour
 * lecture des indices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PromptZoneWatcher, findPromptZone } from "./prompt-zone-watcher.js";

const CTX = { nowMs: 1_700_000_000_000 };
const BAR = "─".repeat(60);
const FULL_BOX = `${BAR}\n❯ \n${BAR}`;

test("detects the prompt box (── + ❯ + ──)", () => {
    const w = new PromptZoneWatcher();
    const pane = `claude output\nfoo\n${FULL_BOX}\nfooter hint`;
    assert.equal(w.observe(pane, CTX).visible, true);
});

test("rejects a single `─` line without `❯`", () => {
    const w = new PromptZoneWatcher();
    const pane = `${BAR}\nrandom\n${BAR}`;
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("rejects a `❯` line without surrounding `─` lines", () => {
    const w = new PromptZoneWatcher();
    const pane = `claude output\n❯ \nfooter hint`;
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("rejects a short `─` run (< 20 chars)", () => {
    const w = new PromptZoneWatcher();
    const short = "─".repeat(10);
    const pane = `${short}\n❯ \n${short}`;
    assert.equal(w.observe(pane, CTX).visible, false);
});

test("emits begin/end on visibility transitions (not one-shot)", () => {
    const w = new PromptZoneWatcher();
    const begins: boolean[] = [];
    const ends: boolean[] = [];
    w.on("begin", () => begins.push(true));
    w.on("end", () => ends.push(true));
    w.observe("nothing", CTX);
    assert.deepEqual(begins, []);
    w.observe(FULL_BOX, CTX);
    assert.deepEqual(begins, [true]);
    // Idempotent : same state → no re-emit.
    w.observe(FULL_BOX, CTX);
    assert.deepEqual(begins, [true]);
    assert.deepEqual(ends, []);
    // Disappears → end.
    w.observe("clean", CTX);
    assert.deepEqual(ends, [true]);
    // Reappears → begin again (not one-shot).
    w.observe(FULL_BOX, CTX);
    assert.deepEqual(begins, [true, true]);
});

test("findPromptZone returns the indices of top / chevron / bottom", () => {
    const pane = [
        "header",
        "filler",
        BAR,                 // index 2 — top
        "❯ typed text",      // index 3 — chevron
        BAR,                 // index 4 — bottom
        "footer hint",
    ].join("\n");
    const zone = findPromptZone(pane);
    assert.ok(zone !== null);
    assert.equal(zone!.top, 2);
    assert.equal(zone!.chevron, 3);
    assert.equal(zone!.bottom, 4);
});

// #1588 — the regression that mattered. Reproduced from a live capture of an
// aiball loop: Claude Code writes the session label INTO the top rule, and the
// old `/^─{20,}$/` full-match rejected it. `promptZoneW.visible` was then false
// forever, which silently disarmed the authoritative busy release and the
// pane-idle turn-end fallback. Measured 0/30 on real captures before the fix.
const LABELLED_TOP = `${"─".repeat(40)} claude-aiball-dev ──`;
const REAL_BOX = [
    "  ⎿  Running…",
    "",
    "✻ Coalescing… (23s · ↓ 730 tokens)",
    "",
    LABELLED_TOP,
    "❯ ",
    BAR,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
].join("\n");

test("detects the box when the top rule carries the session label", () => {
    const zone = findPromptZone(REAL_BOX);
    assert.ok(zone !== null, "a labelled top rule must not hide the box");
    assert.equal(zone!.top, 4);
    assert.equal(zone!.chevron, 5);
    assert.equal(zone!.bottom, 6);
});

test("a labelled BOTTOM rule works too — the label is not top-specific", () => {
    // Nothing guarantees which rule gets decorated; pinning only the observed
    // side would re-create the same blind spot mirrored.
    const pane = `${BAR}\n❯ \n${LABELLED_TOP}`;
    assert.ok(findPromptZone(pane) !== null);
});

test("zone() snapshot returns the last detected geometry", () => {
    const w = new PromptZoneWatcher();
    w.observe(`pre\n${FULL_BOX}\npost`, CTX);
    const zone = w.zone();
    assert.ok(zone !== null);
    assert.ok(typeof zone!.chevron === "number");
});

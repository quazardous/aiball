/**
 * #953 — PromptZoneWatcher tests. node:test, no I/O.
 *
 * Pins the structural regex (2 `─{20,}` lines framing a `❯`)
 * + begin/end transitions + the `findPromptZone` helper exported for
 * reading the indices.
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

// #4121 — a prompt waiting in Claude Code's queue. Recorded on 2.1.312 through
// the session host (tvty's loop, 2026-10-30 07:02, a message typed while Claude
// worked); bottom of the screen only, rules shortened. Note the no-break space
// after the chevron in the input box.
const QUEUED_2_1_312 = [
    "❯ decrit ce composant de panneau stacké",
    "  ctrl+x ctrl+s to send now",
    "",
    "✢ Brewing… (38s · ↓ 660 tokens)",
    "",
    "────────────────────────────────────────────────",
    "❯ Press up to edit queued messages",
    "────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent",
].join("\n");

test("#4121 the queued hint in the input box is a queued prompt", async () => {
    const { promptShowsQueued } = await import("./prompt-zone-watcher.js");
    assert.equal(promptShowsQueued(QUEUED_2_1_312), true);
    // Without the activity line (a compaction draws none): still queued.
    assert.equal(promptShowsQueued(QUEUED_2_1_312.replace("✢ Brewing… (38s · ↓ 660 tokens)", "")), true);
    // A plain space instead of the no-break one.
    assert.equal(promptShowsQueued(QUEUED_2_1_312.replace("❯ Press", "❯ Press")), true);
});

test("#4121 the same words outside the input box are not a queue", async () => {
    const { promptShowsQueued } = await import("./prompt-zone-watcher.js");
    // Delivered: the box is empty again, the "send now" line scrolled into the transcript.
    assert.equal(promptShowsQueued(QUEUED_2_1_312.replace("❯ Press up to edit queued messages", "❯")), false);
    // Quoted on screen above an empty box (a capture, code being read).
    const quoted = [
        "  // ❯ Press up to edit queued messages",
        "  ctrl+x ctrl+s to send now",
        "────────────────────────────────────────────────",
        "❯",
        "────────────────────────────────────────────────",
    ].join("\n");
    assert.equal(promptShowsQueued(quoted), false);
    // Typed by the human in the box: it does not start the box line.
    assert.equal(promptShowsQueued(QUEUED_2_1_312.replace("❯ Press up", "❯ why does it say Press up")), false);
    // No box at all.
    assert.equal(promptShowsQueued("❯ Press up to edit queued messages"), false);
});

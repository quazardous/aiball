/**
 * #1580 — `paneShowsActivity`, pinned on REAL captures.
 *
 * Every positive shape below was recorded on a win32 loop while it was
 * working; the negative shape is the same pane at rest. This is the corpus
 * that was missing: the previous rule relied on `esc to interrupt`, and no
 * fixture showed it absent during a turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneShowsActivity, paneFooterShowsBusy } from "./state.js";

// Recorded as is, spinner glyph included — psmux degrades `✻` to `*`,
// so the rule must above all NOT anchor on it.
const REELLES = [
    "* Honking… (56s · ↓ 2.3k tokens)",
    "✽ Honking… (59s · ↓ 2.3k tokens)",
    "· Honking… (58s · ↓ 2.3k tokens)",
    "✻ Honking… (1m 3s · ↓ 2.3k tokens)",
    "✢ Honking… (1m 7s · ↓ 2.3k tokens)",
    "* Smooshing… (2m 17s · ↓ 6.0k tokens)",
    "  ⎿  Running… (27s · timeout 4m)",
];

test("every activity shape recorded live is detected", () => {
    for (const l of REELLES) {
        assert.equal(paneShowsActivity(l), true, `not detected: ${JSON.stringify(l)}`);
    }
});

test("the gerund and the spinner glyph do NOT carry the rule", () => {
    // Claude Code randomizes the word, psmux degrades the glyph. Anchoring on
    // them would repeat the `esc to interrupt` mistake with another text.
    assert.equal(paneShowsActivity("§ Zorglubbing… (4s · ↓ 1.1k tokens)"), true);
    assert.equal(paneShowsActivity("Honking…"), false, "the word alone proves nothing");
});

test("a pane at rest does not trigger", () => {
    const repos = [
        "──────────────────────────────────────────── aiball-win ──",
        "❯",
        "────────────────────────────────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    assert.equal(paneShowsActivity(repos), false);
});

test("the esc hint is not enough to make an activity, and vice versa", () => {
    // The two proofs are independent: that is the whole point of adding the
    // second one. A capture where claude works WITHOUT the hint is the case
    // that produced the bug, and it must be detected by the activity alone.
    const sansHint = "* Honking… (58s · ↓ 2.3k tokens)";
    assert.equal(paneFooterShowsBusy(sansHint), false, "the hint is absent…");
    assert.equal(paneShowsActivity(sansHint), true, "…but the activity is visible");

    const hintSeul = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt";
    assert.equal(paneFooterShowsBusy(hintSeul), true);
    assert.equal(paneShowsActivity(hintSeul), false);
});

test("the activity is searched on the WHOLE pane, not in the footer window", () => {
    // The activity line sits above the prompt box: on a real capture it was
    // at -6, outside the last 5 non-empty lines (two of which are the box's
    // rules).
    const pane = [
        "* Honking… (58s · ↓ 2.3k tokens)",
        "  ⎿  Tip: something",
        "────────────────────────────────────── aiball-win ──",
        "❯",
        "──────────────────────────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");
    assert.equal(paneShowsActivity(pane), true);
    assert.equal(paneFooterShowsBusy(pane), false, "control: the footer window misses it");
});

// #4437 — Claude Code 2.1.312, recorded on Linux through the session host
// (`host.screen`), 2026-10-30: no `esc to interrupt` anywhere while it works,
// and at rest a "done" line that keeps a spinner glyph. Bottom of the screen
// only. Note the no-break space in "⎿ Running…".
const BUSY_2_1_312 = [
    "  ⎿ \u00a0Running…",
    "",
    "✢ Caramelizing… (39s · ↓ 2.9k tokens)",
    "",
    "──────────────────────────────────────── agent ─",
    "❯",
    "────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent                                                                                                                 /rc",
].join("\n");
const IDLE_2_1_312 = [
    "✻ Sautéed for 30s · done 7:06",
    "",
    "────────────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent                                                                                                                 /rc",
].join("\n");

test("#4437 2.1.312: the activity line carries busy, esc never shows", () => {
    assert.equal(paneShowsActivity(BUSY_2_1_312), true);
    assert.equal(paneFooterShowsBusy(BUSY_2_1_312), false, "the hint is gone since 2.1.304");
});

test("#4437 2.1.312: the \"done\" line at rest is not an activity, glyph and chrono notwithstanding", () => {
    assert.equal(paneShowsActivity(IDLE_2_1_312), false);
    assert.equal(paneShowsActivity("✻ Churned for 9s · done jeudi 09:57"), false);
    assert.equal(paneFooterShowsBusy(IDLE_2_1_312), false);
});

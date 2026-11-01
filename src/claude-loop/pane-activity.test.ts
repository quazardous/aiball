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

// #4616 david `8cgcr5` — forms seen live: the hook ones were not read, and they
// show exactly while the loop has no hook of its own to say a turn started.
test("the activity line while a hook runs, and any other form with a time", () => {
    for (const l of [
        "✶ Sock-hopping… (running UserPromptSubmit hook · 6s)",
        "✽ Smooshing… (3m 52s · ↓ 14.4k tokens)",
        "✢ Gitifying… (42s · ↓ 1.8k tokens)",
        "✶ Whirring… (1h 2m 3s · ↓ 4.5k tokens)",
        "· Pondering… (running stop hooks)",
        "✻ Thinking… (12s)",
    ]) assert.equal(paneShowsActivity(l), true, l);
});

// The row's grammar in Claude Code 2.1.316: every part of the parenthesis is
// optional, and the width drops them.
test("every form the status row can take is read", () => {
    for (const l of [
        "* Sprouting… (49s · ↓ 2.1k tokens · thinking)",
        "✢ Baking… (running Stop hooks… 1/2 · 12s · ↓ 1.2k tokens)",
        "· Baking… (12s · ↓ 1.2k tokens · thought for 5s)",
        "✢ Baking… (9s · thinking)",
        "✳ Baking… (thinking)",
        "✳ Baking… (still thinking)",
        "✶ Baking… (deep in thought)",
        "✢ Baking… (2m 3s · thought for 12s)",
        "✻ Baking… (running tool for 1m 2s)",
        "· Baking… (running Stop hooks… 1/2 · 5s)",
        "✽ Baking… (checking the build…)",
        "✶ Compacting conversation… (12s)",
        "✻ Waiting for API response · will retry in 12s · check your network",
        "✻ Slow lane · next try in 30s · attempt 2 · esc to interrupt",
    ]) assert.equal(paneShowsActivity(l), true, l);
});

test("what only looks like it does not count", () => {
    for (const l of [
        "Loading… (see docs)",
        "Saved… (build 42s3)",
        "  ⎿  rang -8 | ✶ Sock-hopping… (running UserPromptSubmit hook · 6s)",
        "the line says `✶ Sock-hopping… (running UserPromptSubmit hook · 6s)`",
        "We should wait for the API response, then retry in a while",
        "✻ Churned for 9s",
    ]) assert.equal(paneShowsActivity(l), false, l);
});

const box = (above: string[]) => [...above, "", "─".repeat(60), "❯ ", "─".repeat(60), "  ⏵⏵ auto mode on"].join("\n");

test("the bare row of a turn's first seconds counts only right above the input box", () => {
    assert.equal(paneShowsActivity(box(["some output", "✶ Sock-hopping…"])), true);
    assert.equal(paneShowsActivity(box(["✶ Sock-hopping…", "  ⎿  ◻ a task", "  ⎿  ◻ another"])), true, "its task list under it");
    assert.equal(paneShowsActivity(box(["✶ Sock-hopping…", "the reply goes on here"])), false, "text under it: an old line");
    assert.equal(paneShowsActivity(box(["Honking…"])), false, "no glyph, no row");
    assert.equal(paneShowsActivity(box(["* note the ellipsis…", "more"])), false);
    assert.equal(paneShowsActivity("✶ Sock-hopping…"), false, "no box on screen: nothing anchors it");
});

// #992/#993 — structural detection of "is the prompt empty or not" + the
// PromptInputWatcher indicator that drives the coloured `❯` glyph. INDICATOR
// only (david is exploring) — it does NOT change the busy-clear rule.
//
// The detection is CURSOR-based : Claude shows greyed ghost-suggestions in the
// box (applied via Tab) that look like typed text in capture-pane — only the
// cursor tells real input (left of cursor) from a suggestion (right of it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptInputEmpty, PromptInputWatcher } from "./prompt-zone-watcher.js";

const RULE = "─".repeat(40);
const NBSP = " "; // empty Claude prompt renders `❯` + U+00A0

// input box : line 0 misc, 1 top rule, 2 chevron, 3 bottom rule, 4 footer.
function box(chevronInput: string): string {
    return [
        "  some conversation output above",
        RULE,
        `❯ ${chevronInput}`,
        RULE,
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
}
const CHEVRON_ROW = 2;
const INPUT_COL = 2; // after `❯ `

const EMPTY = box(NBSP);
const TYPED = box("option 1");
const GHOST = box("git commit --amend"); // greyed suggestion, user typed nothing

// --- cursorless fallback (replay/tests) ---
test("fallback (no cursor): empty box true, text false", () => {
    assert.equal(promptInputEmpty(EMPTY), true);
    assert.equal(promptInputEmpty(TYPED), false);
    assert.equal(promptInputEmpty("no box here"), false);
});

// --- cursor-based (the live path) ---
test("cursor: ghost suggestion with cursor at input start reads as EMPTY", () => {
    // cursor parked at the input start → nothing typed, the text is a suggestion
    assert.equal(promptInputEmpty(GHOST, { cursorX: INPUT_COL, cursorY: CHEVRON_ROW }), true);
});

test("cursor: real typed text (cursor past the input) reads as NON-empty", () => {
    // user typed "option 1" → cursor at end of it
    assert.equal(promptInputEmpty(TYPED, { cursorX: INPUT_COL + "option 1".length, cursorY: CHEVRON_ROW }), false);
});

test("cursor: text present but cursor NOT on the chevron row → falls back (treats as typed)", () => {
    // cursor elsewhere → can't use it, fallback sees the line text
    assert.equal(promptInputEmpty(TYPED, { cursorX: 0, cursorY: 0 }), false);
});

test("PromptInputWatcher: visible iff real unsent text (ghost excluded via cursor)", () => {
    const ghostCtx = { nowMs: 0, cursorX: INPUT_COL, cursorY: CHEVRON_ROW };
    const typedCtx = { nowMs: 0, cursorX: INPUT_COL + 8, cursorY: CHEVRON_ROW };
    assert.equal(new PromptInputWatcher().observe(GHOST, ghostCtx).visible, false, "ghost suggestion must NOT light the glyph");
    assert.equal(new PromptInputWatcher().observe(TYPED, typedCtx).visible, true, "real typed text lights the glyph");
    assert.equal(new PromptInputWatcher().observe(EMPTY, ghostCtx).visible, false);
});

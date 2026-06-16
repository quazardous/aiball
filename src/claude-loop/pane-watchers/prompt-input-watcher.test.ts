// #992/#993 — "is the prompt empty or not", CURSOR-COLUMN rule (david : "si le
// curseur n'est pas à l'origine de l'input, c'est qu'on tape, c'est tout").
// Content-independent → immune to Claude's greyed ghost-suggestions and hint
// lines (both leave the cursor parked at the input start). INDICATOR only —
// drives the coloured `❯` glyph, does NOT change the busy-clear rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptInputEmpty, PromptInputWatcher } from "./prompt-zone-watcher.js";

const RULE = "─".repeat(40);
function box(chevronInput: string): string {
    return [
        "  some conversation output above",
        RULE,
        `❯ ${chevronInput}`,
        RULE,
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
}
const ROW = 2;        // chevron line index
const ORIGIN = 2;     // input-start column (after `❯ `)

// --- cursor-column rule (the live path) ---
test("cursor AT origin → empty, whatever the line shows (ghost / hint / moved-home)", () => {
    assert.equal(promptInputEmpty(box(""), { cursorX: ORIGIN, cursorY: ROW }), true);
    assert.equal(promptInputEmpty(box("git commit --amend"), { cursorX: ORIGIN, cursorY: ROW }), true); // ghost
    assert.equal(promptInputEmpty(box("Press up to edit queued messages"), { cursorX: ORIGIN, cursorY: ROW }), true); // hint
    assert.equal(promptInputEmpty(box("weigh in on the color"), { cursorX: ORIGIN, cursorY: ROW }), true); // real text, cursor home
});

test("cursor PAST origin → not empty (the user is typing)", () => {
    assert.equal(promptInputEmpty(box("hi"), { cursorX: ORIGIN + 2, cursorY: ROW }), false);
    assert.equal(promptInputEmpty(box("hello"), { cursorX: ORIGIN + 1, cursorY: ROW }), false); // cursor mid-word still = typing
});

test("cursor not on the chevron row → falls back to text", () => {
    assert.equal(promptInputEmpty(box("typed"), { cursorX: 0, cursorY: 0 }), false);
    assert.equal(promptInputEmpty(box(""), { cursorX: 0, cursorY: 0 }), true);
});

test("no cursor (replay/tests) → text-based fallback", () => {
    assert.equal(promptInputEmpty(box("")), true);
    assert.equal(promptInputEmpty(box("typed")), false);
    assert.equal(promptInputEmpty("no box here"), false);
});

test("PromptInputWatcher: lights only when the cursor is past the input start", () => {
    const atOrigin = { nowMs: 0, cursorX: ORIGIN, cursorY: ROW };
    const typing = { nowMs: 0, cursorX: ORIGIN + 3, cursorY: ROW };
    assert.equal(new PromptInputWatcher().observe(box("ghosted text"), atOrigin).visible, false);
    assert.equal(new PromptInputWatcher().observe(box("abc"), typing).visible, true);
});

// #992/#993 — "is the prompt empty or not", CURSOR-COLUMN rule (david: "if the
// cursor is not at the input origin, someone is typing, that's all").
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

// --- the shape `capture-pane` REALLY returns ------------------------------
// `box()` above writes `❯ ` by hand, with its space. capture-pane trims
// trailing blanks: an empty prompt comes back as a bare `❯`. So the fixture
// was more generous than reality, and hid a one-column offset — the cursor
// parked at the origin (2) read as "right of the start", so "typing".
// Measured on a real pane: line `"❯"`, cursor `2,36`, verdict "not empty" on
// a plainly empty prompt.
function captured(chevronInput: string): string {
    return [
        "  some conversation output above",
        RULE,
        `❯ ${chevronInput}`.replace(/\s+$/u, ""),   // like capture-pane
        RULE,
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
}

test("captured empty prompt (trailing space trimmed) → empty, cursor at the origin", () => {
    assert.equal(captured("").split("\n")[ROW], "❯", "control: the space is really gone");
    assert.equal(promptInputEmpty(captured(""), { cursorX: ORIGIN, cursorY: ROW }), true);
});

test("greyed suggestion on a captured pane → empty (the whole point of the cursor)", () => {
    assert.equal(promptInputEmpty(captured("git commit --amend"), { cursorX: ORIGIN, cursorY: ROW }), true);
});

test("real input on a captured pane → not empty", () => {
    assert.equal(promptInputEmpty(captured("hi"), { cursorX: ORIGIN + 2, cursorY: ROW }), false);
});

test("an indented prompt keeps its relative origin", () => {
    const indented = captured("").replace("❯", "  ❯");
    assert.equal(promptInputEmpty(indented, { cursorX: 4, cursorY: ROW }), true);
    assert.equal(promptInputEmpty(indented, { cursorX: 5, cursorY: ROW }), false);
});

test("PromptInputWatcher: lights only when the cursor is past the input start", () => {
    const atOrigin = { nowMs: 0, cursorX: ORIGIN, cursorY: ROW };
    const typing = { nowMs: 0, cursorX: ORIGIN + 3, cursorY: ROW };
    assert.equal(new PromptInputWatcher().observe(box("ghosted text"), atOrigin).visible, false);
    assert.equal(new PromptInputWatcher().observe(box("abc"), typing).visible, true);
});

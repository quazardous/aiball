// #992/#993 — structural detection of "is the prompt empty or not" + the
// PromptInputWatcher indicator that drives the coloured `❯` glyph. This is an
// INDICATOR only (david is exploring) — it does NOT change the busy-clear rule.
// Fixtures replicate the real captured Claude Code input-box structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptInputEmpty, PromptInputWatcher } from "./prompt-zone-watcher.js";

const CTX = { nowMs: 0 };
const RULE = "─".repeat(40);
const NBSP = " "; // empty Claude prompt renders `❯` + U+00A0, no padding

// a Claude Code input box : top rule, chevron line, bottom rule.
function box(chevronInput: string): string {
    return [
        "  some conversation output above",
        RULE,
        `❯ ${chevronInput}`,
        RULE,
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
}

const EMPTY = box(NBSP);
const TYPED = box("option 1, weigh in on the color");

test("promptInputEmpty: true for an empty box, false once text is typed", () => {
    assert.equal(promptInputEmpty(EMPTY), true);
    assert.equal(promptInputEmpty(TYPED), false);
    assert.equal(promptInputEmpty("no input box here"), false); // no zone → not empty
});

test("PromptInputWatcher: visible only when the box has unsent text", () => {
    assert.equal(new PromptInputWatcher().observe(EMPTY, CTX).visible, false);
    assert.equal(new PromptInputWatcher().observe(TYPED, CTX).visible, true);
    assert.equal(new PromptInputWatcher().observe("no box", CTX).visible, false);
});

test("PromptInputWatcher: empty→typed emits begin (→ colour the glyph)", () => {
    const w = new PromptInputWatcher();
    let begins = 0;
    w.on("begin", () => { begins++; });
    w.observe(EMPTY, CTX); // empty: no begin
    w.observe(TYPED, CTX); // text appears → begin
    assert.equal(begins, 1);
});

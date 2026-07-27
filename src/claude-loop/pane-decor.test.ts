/**
 * #1588 — the pane-decoration predicates, pinned against a REAL capture.
 *
 * The bug these close: `findPromptZone` asked both rules framing the prompt to
 * be a pure run of `─`. On a real aiball loop the top rule carries the session
 * label, so the box stopped being detected at all — measured 0 hits over 30
 * consecutive captures of a working loop. Every "decorated" string below is
 * copied from those captures, not invented.
 *
 * Run: `npx tsx --test src/claude-loop/pane-decor.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFrameRule, isPromptLine } from "./pane-decor.js";

const RUN = "─".repeat(60);
/** Verbatim from a live capture: the run, the session label, then two more. */
const LABELLED_RULE = `${"─".repeat(40)} claude-aiball-dev ──`;

test("a rule carrying a label is still a rule — the case that broke", () => {
    assert.equal(isFrameRule(LABELLED_RULE), true);
});

test("a pure rule is still a rule — the other platform's shape must keep working", () => {
    // aiball-win's Windows captures show undecorated rules. The fix must widen
    // the predicate, not move it: both shapes have to pass.
    assert.equal(isFrameRule(RUN), true);
    assert.equal(isFrameRule(`  ${RUN}`), true, "leading indentation is not meaningful");
});

test("a short run is not a rule", () => {
    // Claude Code draws its boxes at terminal width, so a short run is a
    // separator inside rendered conversation.
    assert.equal(isFrameRule("─".repeat(19)), false);
    assert.equal(isFrameRule("─".repeat(20)), true, "the threshold itself passes");
});

test("a rule has to START with the run — trailing decoration only", () => {
    // Otherwise any conversation line that happens to contain a long rule
    // (a rendered table, quoted output) would be eaten by the filter.
    assert.equal(isFrameRule(`some text ${RUN}`), false);
    assert.equal(isFrameRule("⏵⏵ auto mode on (shift+tab to cycle)"), false);
    assert.equal(isFrameRule(""), false);
});

test("prompt lines are recognised, including the empty prompt", () => {
    // The empty Claude prompt renders as `❯` + U+00A0, NOT an ASCII space —
    // this is what the pane actually contains, and `\s` covers it.
    assert.equal(isPromptLine("❯ "), true);
    assert.equal(isPromptLine("❯ typed text"), true);
    assert.equal(isPromptLine("> legacy prompt"), true);
    assert.equal(isPromptLine("❯no separator"), false);
    assert.equal(isPromptLine("not a prompt"), false);
});

test("the two predicates do not overlap", () => {
    // They are applied as independent filters ; if one line could be both,
    // dropping it twice would be a silent double-count of the budget.
    for (const line of [LABELLED_RULE, RUN, "❯ x", "> x"]) {
        assert.equal(
            isFrameRule(line) && isPromptLine(line),
            false,
            `${JSON.stringify(line)} classified as both`,
        );
    }
});

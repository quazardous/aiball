// #992 — IdlePromptWatcher now keys on a STRUCTURAL empty-input-box signal
// (david: "savoir si le prompt est vide ou pas") instead of the footer hint
// `ctrl+t to show task`. Regression: the agents UI shows `← for agents` at idle
// (no `ctrl+t`), which used to leave the busy latch stuck ~5min after an
// ESC-interrupt. Fixtures replicate the real captured pane box structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdlePromptWatcher } from "./runtime-watchers.js";
import { promptInputEmpty } from "./prompt-zone-watcher.js";

const CTX = { nowMs: 0 };
const RULE = "─".repeat(40);
const NBSP = " "; // the empty Claude prompt renders `❯` + U+00A0, no padding

// A Claude Code input box : top rule, chevron line, bottom rule, then a footer.
function pane(chevronInput: string, footerHint: string): string {
    return [
        "  some conversation output above",
        RULE,
        `❯ ${chevronInput}`,
        RULE,
        `  ⏵⏵ auto mode on (shift+tab to cycle) · ${footerHint}`,
    ].join("\n");
}

const IDLE_AGENTS = pane(NBSP, "← for agents");        // pisynth/agents UI idle
const IDLE_SHORTCUTS = pane(NBSP, "? for shortcuts");  // classic idle
const BUSY = pane(NBSP, "esc to interrupt");           // mid-turn (empty box + busy footer)
const TYPING = pane("réponse en cours de frappe", "← for agents"); // user typing at prompt

test("promptInputEmpty: empty box true, typed box false", () => {
    assert.equal(promptInputEmpty(IDLE_AGENTS), true);
    assert.equal(promptInputEmpty(TYPING), false);
    assert.equal(promptInputEmpty("no box here at all"), false);
});

test("IdlePromptWatcher: fires on empty prompt regardless of footer-hint variant", () => {
    for (const [label, p] of [["agents", IDLE_AGENTS], ["shortcuts", IDLE_SHORTCUTS]] as const) {
        const w = new IdlePromptWatcher();
        assert.equal(w.observe(p, CTX).visible, true, `idle must fire on ${label} UI (was broken pre-#992)`);
    }
});

test("IdlePromptWatcher: does NOT fire while busy (empty box but esc-to-interrupt footer)", () => {
    const w = new IdlePromptWatcher();
    assert.equal(w.observe(BUSY, CTX).visible, false, "busy footer must veto the idle signal");
});

test("IdlePromptWatcher: does NOT fire while typing at the prompt (box not empty)", () => {
    const w = new IdlePromptWatcher();
    assert.equal(w.observe(TYPING, CTX).visible, false, "non-empty input must not read as idle (#890)");
});

test("IdlePromptWatcher: busy→idle emits begin (clears the latch)", () => {
    const w = new IdlePromptWatcher();
    let begins = 0;
    w.on("begin", () => { begins++; });
    w.observe(BUSY, CTX);        // busy: no begin
    w.observe(IDLE_AGENTS, CTX); // returns to empty idle prompt → begin
    assert.equal(begins, 1, "the busy→idle transition must fire begin (→ setPaneBusy(false))");
});

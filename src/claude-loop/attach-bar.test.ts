/** #3469 — the loop's bar as `claude-loop attach` draws it on the session host: tmux's status line, the same. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachBarRow, cellsOf, expandFormat, snapshotFromAgentBar, tmuxToAnsi, type AttachBarSetup } from "./attach-bar.js";
import { barOptionValues, statusRightFormat, type BarColors } from "./bar-renderer.js";
import { sampleBar } from "./attach-bar.fixture.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const at = (s: number) => new Date(NOW + s * 1000).toISOString();
const COL: BarColors = { island_fg: "colour250", bar_fg: "colour16", afk_label_fg: "colour238", prompt_input_fg: "colour208", busy_bg: "colour33", idle_bg: "colour34", boot_bg: "colour178", link_down_bg: "colour196" };
const SETUP: AttachBarSetup = { colors: COL, name: "cl-demo", afkKey: "F9", detach: "C-b d", readonly: false };
/** What a row shows, its styles and cursor moves taken out. */
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b[78]/g, "");

test("the snapshot from the published bar is the one the kernel paints from: glyphs, state, counters, countdowns", () => {
    const snap = snapshotFromAgentBar({ bar: sampleBar({ next_wake_at: at(12), counters: { open: 3, backlog: 1, events: 0 } }), stale: false }, NOW, COL);
    assert.equal(snap.loopStatus, "idle");
    assert.equal(snap.stateTag, "💤");
    assert.equal(snap.humanWord, " #[fg=colour40,bg=colour16]▶", "autonomous: ▶ green");
    assert.equal(snap.afkGlyph, " #[fg=colour238,bg=colour16]웃", "AFK off: 웃 dim");
    assert.equal(snap.promptGlyph, "❯");
    assert.equal(snap.nextWakeInSec, 12);
    const held = snapshotFromAgentBar({ bar: sampleBar({ afk: { mode: "wait_10m", expires_at: at(90) } }), stale: false }, NOW, COL);
    assert.equal(held.humanWord, " #[fg=colour178,bg=colour16]⏸");
    assert.equal(held.afkGlyph, " #[fg=colour178,bg=colour16]웃90s");
    const forGood = snapshotFromAgentBar({ bar: sampleBar({ afk: { mode: "wait_inf", expires_at: null }, phase: "busy" }), stale: false }, NOW, COL);
    assert.equal(forGood.afkGlyph, " #[fg=colour196,bg=colour16]웃∞");
    assert.equal(forGood.stateTag, "🧠");
    assert.equal(snapshotFromAgentBar({ bar: sampleBar(), stale: true }, NOW, COL).linkDown, true, "a loop gone shows the lost-link red");
});

test("the row: tmux's left side and right side, the same words in the same order", () => {
    const view = { bar: sampleBar({ next_wake_at: at(12), counters: { open: 3, backlog: 1, events: 0 }, proxy_alive: true }), stale: false };
    const shown = visible(attachBarRow(24, 160, view, NOW, SETUP));
    const opts = barOptionValues(snapshotFromAgentBar(view, NOW, COL), COL);
    const left = visible(tmuxToAnsi(expandFormat(opts["status-left"], opts, SETUP), "x", "y", 90).text);
    assert.equal(left, " ▓▒░ 웃 ❯ ▶ claude 💤 ░▒▓ ⇄ o:3 b:1 e:0 📨 12s ");
    assert.ok(shown.startsWith(left), "the left side first");
    assert.ok(shown.trimEnd().endsWith("cl-demo · DETACH:C-b d · AFK:F9"), "the right side against the edge");
});

test("a read-only copy leads with tmux's COPY mark; ZEN shows on the right; no bar yet says so", () => {
    const view = { bar: sampleBar({ zen: true }), stale: false };
    const shown = visible(attachBarRow(24, 160, view, NOW, { ...SETUP, readonly: true }));
    assert.ok(shown.startsWith(" 👁 COPY · read-only · C-b d to leave "), shown);
    assert.ok(shown.includes(" ZEN  cl-demo"), "tmux's ZEN chip, then the name");
    assert.ok(visible(attachBarRow(24, 80, null, NOW, SETUP)).includes("waiting for the loop's bar"));
});

test("tmux styles become terminal colours, `default` goes back to the status colours, cut to the width", () => {
    const { text, cells } = tmuxToAnsi("#[fg=colour16,bg=colour226,bold]ab#[default]c##", "colour16", "colour34", 10);
    assert.equal(text, "\x1b[0;38;5;16;48;5;34m\x1b[0;1;38;5;16;48;5;226mab\x1b[0;38;5;16;48;5;34mc#");
    assert.equal(cells, 4);
    assert.equal(tmuxToAnsi("웃💤abc", "default", "default", 5).cells, 5, "웃 and 💤 take two columns each");
    assert.equal(cellsOf("▓"), 1);
});

test("the right side is tmux's own format", () => {
    assert.equal(statusRightFormat(COL, "F9", "C-b d"), "#{@cl_zen}#[fg=colour16]#{@cl_name} #[fg=colour238]· DETACH:#[fg=colour16]C-b d #[fg=colour238]· #[fg=colour238]AFK:#[fg=colour16]F9 ");
    assert.ok(statusRightFormat(COL, null, "C-b d").includes("AFK:OFF"));
});

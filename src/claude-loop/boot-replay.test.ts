// #990 S3 — boot replay reproduces the compact_confirm boot-infini from a
// synthetic capture, deterministically (no tmux, no claude, virtual clock).
//
// David's exact path: resume_picker → resuming → compact_confirm
// ("Compact this conversation?") → compacting → prompt. He reports: with the
// compact_confirm step the boot phase is INFINITE; without it the boot seals
// 10s after the last transient. The replay drives the REAL watchers +
// bootMachine, so it proves the mechanism (and, post-fix, the regression).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replayBootFrames, replayBootFromCapture, type ReplayPaneFrame } from "./boot-replay.js";

// --- faithful pane fixtures (footer-scoped detectors look at last lines) ---

const PICKER = [
    "  Resume session",
    "  Use ↑↓ to navigate · Space to preview · Enter to select",
    "  > 1. feat: …    2h ago",
].join("\n");

const RESUMING = "  Resuming conversation…\n";

// compact_confirm screen — the y/N takeover. Footer carries the prompt.
const COMPACT_CONFIRM = [
    "  Compact this conversation?",
    "  This will summarize and replace the context. [y/N]",
].join("\n");

// the actual compact running — header text + footer progress bar.
const COMPACTING = [
    "  ✶ Compacting conversation…",
    "  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱ 34%",
].join("\n");

// clean idle prompt — nothing transient in the footer.
const PROMPT_CLEAN = [
    "  ❯ ",
    "  ? for shortcuts",
].join("\n");

// BUGGY post-compact pane: claude is at the prompt and working, but the
// "Compact this conversation?" line still lingers in the short post-compact
// scrollback, inside the 12-line footer window the watcher scans.
const PROMPT_WITH_LINGERING_CONFIRM = [
    "  Compact this conversation?",       // <- lingers in footer scope
    "  (done — summary applied)",
    "  ❯ ",
    "  ? for shortcuts",
].join("\n");

function frames(specs: Array<[number, string]>): ReplayPaneFrame[] {
    // specs: [relSeconds, text] → epoch-ms frames (base 1_000_000s)
    const base = 1_000_000_000;
    return specs.map(([rel, text], i) => ({ tMs: (base + rel) * 1000, file: `panes/${i}.txt`, text }));
}

const OPTS = { bootMinMs: 30_000, tunnelMs: 10_000, tailMs: 120_000 };

test("control: resume → resuming → compact → CLEAN prompt → boot SEALS", () => {
    const r = replayBootFrames(frames([
        [0, PICKER],
        [2, RESUMING],
        [4, COMPACT_CONFIRM],
        [6, COMPACTING],
        [10, PROMPT_CLEAN],
    ]), OPTS);
    assert.equal(r.sealed, true, "a clean boot must seal");
    assert.deepEqual(r.finalActiveModules, [], "no module left dangling");
    // sealed after the last transient cleared + the 10s tunnel, comfortably
    // before the tail horizon.
    assert.ok(r.sealedAtRelMs !== null && r.sealedAtRelMs >= 10_000, `sealed too early: ${r.sealedAtRelMs}`);
});

test("BUG: same path but compact_confirm LINGERS in footer → boot NEVER seals", () => {
    const r = replayBootFrames(frames([
        [0, PICKER],
        [2, RESUMING],
        [4, COMPACT_CONFIRM],
        [6, COMPACTING],
        [10, PROMPT_WITH_LINGERING_CONFIRM],
    ]), OPTS);
    assert.equal(r.sealed, false, "boot must NOT seal while compact_confirm lingers (the bug)");
    assert.deepEqual(r.finalActiveModules, ["compact_confirm"], "smoking gun: compact_confirm stuck active");
});

test("cold clean boot (no transients) seals at the floor", () => {
    const r = replayBootFrames(frames([[0, PROMPT_CLEAN]]), OPTS);
    assert.equal(r.sealed, true);
    assert.equal(r.sealReason, "deadline");
    // floor = bootMinMs (30s), no module ever pushed the deadline.
    assert.ok(r.sealedAtRelMs !== null && r.sealedAtRelMs >= 30_000 && r.sealedAtRelMs <= 31_000,
        `expected seal near floor 30s, got ${r.sealedAtRelMs}`);
});

test("replayBootFromCapture: reads a real capture dir (panes.ndjson + frames)", () => {
    const sd = mkdtempSync(join(tmpdir(), "boot-replay-990-"));
    const cap = join(sd, "capture");
    mkdirSync(join(cap, "panes"), { recursive: true });
    const base = 1_000_000_000;
    const specs: Array<[number, string]> = [
        [0, PICKER], [2, RESUMING], [4, COMPACT_CONFIRM], [6, COMPACTING],
        [10, PROMPT_WITH_LINGERING_CONFIRM],
    ];
    const rows = specs.map(([rel, text], i) => {
        const file = `panes/${i}.txt`;
        writeFileSync(join(cap, file), text);
        return JSON.stringify({ t: base + rel, kind: "pane", file });
    });
    writeFileSync(join(cap, "panes.ndjson"), rows.join("\n") + "\n");

    const r = replayBootFromCapture(cap, OPTS);
    assert.equal(r.paneFrameCount, 5);
    assert.equal(r.sealed, false, "lingering compact_confirm capture → boot stuck");
    assert.deepEqual(r.finalActiveModules, ["compact_confirm"]);
    rmSync(sd, { recursive: true, force: true });
});

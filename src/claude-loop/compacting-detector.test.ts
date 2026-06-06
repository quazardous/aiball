// #843 — Unified compacting detector tests. See `compacting-detector.ts`
// for the design rationale (wider footer, end-of-line `%`, latch).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CompactingDetector,
    classifyCompacting,
    isCompactConfirmPrompt,
} from "./compacting-detector.js";

// Real-shape capture (from skybot 2026-06-06 #843 repro): the compact
// block sits 5-7 non-empty lines above the prompt (separator box + auto-
// mode footer eats 4-5 non-empty lines at the bottom).
const liveCompactCapture = [
    "● Clean. Idle.",
    "",
    "✻ Cooked for 10s",
    "",
    "❯ /compact",
    "",
    "✢ Compacting conversation… (27s)",
    "  ▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 27%",
    "  ⎿  Next: #576: dataimpulse instance runic-forward + live smoke",
    "",
    "─".repeat(80),
    "❯ ",
    "─".repeat(80),
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ctrl+t to show tasks",
].join("\n");

test("classifyCompacting: live /compact with bar+EOL% in the wider footer → true", () => {
    // With default footerLines=12, the `▰▱…▱ 27%` line is captured.
    assert.equal(classifyCompacting(liveCompactCapture), true);
});

test("classifyCompacting: rejects the legacy 5-line footer scope (regression guard)", () => {
    // Verify the bug 2 root cause: with footerLines=5 the live signal
    // sits one line too high → returns false. The fix is widening the
    // default; this test pins the cause.
    assert.equal(classifyCompacting(liveCompactCapture, {}, { footerLines: 5, bootFooterLines: 5 }), false);
});

test("classifyCompacting: ignores the `88% weekly limit` false-positive", () => {
    // The auto-mode banner used to carry a banner like
    //   `… esc to interrupt · ctrl+t to show tasks    You've used 88% of your weekly limit · resets …`
    // The bare `\d+%` test matched that as a live compacting signal,
    // masking the real bug while the banner was present. With the
    // end-of-line constraint, mid-line `%` no longer counts.
    const bannerOnly = [
        "● Clean. Idle.",
        "",
        "❯ ",
        "─".repeat(80),
        "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ctrl+t to show tasks                                                           You've used 88% of your weekly limit · resets Jun 9, 7am (Europe/Paris)",
    ].join("\n");
    // No `Compacting conversation` text anyway, but more importantly:
    // even if we add it as scrollback, the % alone (mid-line) shouldn't
    // promote it to compacting.
    assert.equal(classifyCompacting(bannerOnly), false);
    const staleScrollbackWithBanner = "Compacting conversation… (42s)\n\n\n\n" + bannerOnly;
    assert.equal(classifyCompacting(staleScrollbackWithBanner), false);
});

test("classifyCompacting: stale 'Compacting' in scrollback without live signal → false", () => {
    const stale = [
        "✢ Compacting conversation… (42s)",
        ...Array.from({ length: 15 }, (_, i) => `line ${i}`),
        "─".repeat(80),
        "❯ ",
        "─".repeat(80),
        "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
    ].join("\n");
    assert.equal(classifyCompacting(stale), false);
});

test("classifyCompacting: `Summarizing the conversation` text + bar → true", () => {
    const t = "✶ Summarizing the conversation… (8s)\n  ▰▰▱▱▱…▱ 12%";
    assert.equal(classifyCompacting(t), true);
});

test("classifyCompacting: text alone with no live signal → false", () => {
    assert.equal(classifyCompacting("Compacting conversation…"), false);
});

test("classifyCompacting: isBoot widens the footer scope further", () => {
    // Simulate a layout where the bar is 13 non-empty lines above the
    // bottom — out of the default post-boot (12) scope, inside the boot
    // scope (18).
    const lines = [
        "Compacting conversation…",
        "  ▰▱▱▱▱…▱ 5%",
        ...Array.from({ length: 13 }, (_, i) => `padding line ${i}`),
    ];
    const text = lines.join("\n");
    assert.equal(classifyCompacting(text, { isBoot: false }), false);
    assert.equal(classifyCompacting(text, { isBoot: true }), true);
});

// ---------------------------------------------------------------------------
//  Latch behaviour (CompactingDetector class)
// ---------------------------------------------------------------------------

test("CompactingDetector: positive sighting starts the latch", () => {
    const det = new CompactingDetector({ latchGraceMs: 10_000 });
    assert.equal(det.detect(liveCompactCapture, { nowMs: 1_000 }), true);
});

test("CompactingDetector: stays true within grace window after raw flips false", () => {
    const det = new CompactingDetector({ latchGraceMs: 10_000 });
    assert.equal(det.detect(liveCompactCapture, { nowMs: 1_000 }), true);
    // 5s later, classifier returns false (frame race) — latched true.
    assert.equal(det.detect("idle pane", { nowMs: 6_000 }), true);
});

test("CompactingDetector: drops false after the grace window elapses", () => {
    const det = new CompactingDetector({ latchGraceMs: 10_000 });
    assert.equal(det.detect(liveCompactCapture, { nowMs: 1_000 }), true);
    // 11s later, still false → grace expired → returns false.
    assert.equal(det.detect("idle pane", { nowMs: 12_000 }), false);
});

test("CompactingDetector: next positive resets the latch clock", () => {
    const det = new CompactingDetector({ latchGraceMs: 5_000 });
    assert.equal(det.detect(liveCompactCapture, { nowMs: 1_000 }), true);
    // 3s later, classifier still positive → reset clock.
    assert.equal(det.detect(liveCompactCapture, { nowMs: 4_000 }), true);
    // Another 3s (total 7s from initial, 3s from last positive) → still
    // latched (grace from the LAST positive, not the first).
    assert.equal(det.detect("idle pane", { nowMs: 7_000 }), true);
});

test("CompactingDetector: reset() drops the latch immediately", () => {
    const det = new CompactingDetector();
    det.detect(liveCompactCapture, { nowMs: 1_000 });
    det.reset();
    assert.equal(det.detect("idle pane", { nowMs: 1_001 }), false);
});

// ---------------------------------------------------------------------------
//  Compact y/N confirmation screen
// ---------------------------------------------------------------------------

test("isCompactConfirmPrompt: question + Yes/No keys at the bottom → true", () => {
    const screen = [
        "(previous output)",
        "",
        "Compact this conversation? [Y/n]",
        "  ❯ Yes",
        "    No",
    ].join("\n");
    assert.equal(isCompactConfirmPrompt(screen), true);
});

test("isCompactConfirmPrompt: stale match high in scrollback → false (footer-scoped)", () => {
    const screen = [
        "Compact this conversation? [Y/n]",
        ...Array.from({ length: 30 }, (_, i) => `intervening line ${i}`),
        "─".repeat(80),
        "❯ ",
        "─".repeat(80),
        "  ⏵⏵ auto mode on",
    ].join("\n");
    assert.equal(isCompactConfirmPrompt(screen), false);
});

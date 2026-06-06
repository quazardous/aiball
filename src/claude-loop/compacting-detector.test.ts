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
//  PaneWatcher surface — observe / snapshot / on (#845)
// ---------------------------------------------------------------------------

test("PaneWatcher: observe returns the same latched state as detect", () => {
    const det = new CompactingDetector({ latchGraceMs: 10_000 });
    const s1 = det.observe(liveCompactCapture, { nowMs: 1_000 });
    assert.deepEqual(s1, { active: true });
    const s2 = det.observe("idle pane", { nowMs: 5_000 });
    assert.deepEqual(s2, { active: true });
    const s3 = det.observe("idle pane", { nowMs: 20_000 });
    assert.deepEqual(s3, { active: false });
});

test("PaneWatcher: snapshot exposes the current state without re-observing", () => {
    const det = new CompactingDetector();
    assert.deepEqual(det.snapshot(), { active: false });
    det.observe(liveCompactCapture, { nowMs: 1_000 });
    assert.deepEqual(det.snapshot(), { active: true });
});

test("PaneWatcher: begin fires once on the false→true transition", () => {
    const det = new CompactingDetector({ latchGraceMs: 10_000 });
    let beginCount = 0;
    det.on("begin", () => { beginCount++; });
    det.observe("idle", { nowMs: 1_000 });   // false→false : no event
    det.observe(liveCompactCapture, { nowMs: 2_000 });  // false→true : begin
    det.observe(liveCompactCapture, { nowMs: 3_000 });  // true→true : no event
    assert.equal(beginCount, 1);
});

test("PaneWatcher: end fires once on the true→false transition", () => {
    const det = new CompactingDetector({ latchGraceMs: 5_000 });
    let endCount = 0;
    det.on("end", () => { endCount++; });
    det.observe(liveCompactCapture, { nowMs: 1_000 });  // false→true : begin
    det.observe("idle", { nowMs: 2_000 });              // latched → still true
    det.observe("idle", { nowMs: 10_000 });             // grace elapsed : end
    assert.equal(endCount, 1);
});

test("PaneWatcher: change fires on every transition with (next, prev)", () => {
    const det = new CompactingDetector({ latchGraceMs: 5_000 });
    const changes: Array<{ next: boolean; prev: boolean | null }> = [];
    det.on("change", (next, prev) => {
        changes.push({ next: next.active, prev: prev ? prev.active : null });
    });
    det.observe(liveCompactCapture, { nowMs: 1_000 });  // false→true
    det.observe("idle", { nowMs: 10_000 });             // true→false (grace elapsed)
    assert.deepEqual(changes, [
        { next: true, prev: false },
        { next: false, prev: true },
    ]);
});

test("PaneWatcher: on returns an unsubscribe closure", () => {
    const det = new CompactingDetector();
    let count = 0;
    const unsub = det.on("change", () => { count++; });
    det.observe(liveCompactCapture, { nowMs: 1_000 });
    unsub();
    det.observe("idle", { nowMs: 20_000 });
    assert.equal(count, 1);
});

test("PaneWatcher: reset clears listeners and state", () => {
    const det = new CompactingDetector();
    let count = 0;
    det.on("change", () => { count++; });
    det.observe(liveCompactCapture, { nowMs: 1_000 });
    det.reset();
    det.observe(liveCompactCapture, { nowMs: 2_000 });   // re-fires change
    // count = 1 from BEFORE reset, listener after reset is gone
    assert.equal(count, 1);
    assert.deepEqual(det.snapshot(), { active: true });  // re-observed positive
});

test("PaneWatcher: name is 'compacting'", () => {
    assert.equal(new CompactingDetector().name, "compacting");
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

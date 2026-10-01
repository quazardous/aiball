/**
 * #1315 — the quiescence witness, pinned at the level that actually matters.
 *
 * The measurement came before the code and changed what it is for. Across four
 * loops on 2026-08-27, `idle_prompt` landed 61.0-61.4 s after the last `Stop`,
 * four times out of four; the `Stop`s that produced none were each followed by
 * another `Stop` inside that minute. So it is NOT a turn-end corroboration —
 * `Stop` already marks that, exactly, a minute earlier. It is an inactivity
 * threshold, and its value is elsewhere: catching our own busy flag lying.
 *
 * What has to hold for the detector to be alive at all is that `phase` reads
 * `"busy"` from `paneBusy` — the pane-scraped latch that goes stale. If that
 * derivation is ever renamed or reshaped, the witness goes SILENT without any
 * test failing, which is the "succeeds while doing nothing" failure this
 * codebase keeps digging out. These tests exist to make that noisy instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeLoopView } from "./loop-state.js";
import type { LoopStateInput } from "./loop-state.js";

const T0 = Date.parse("2026-08-27T09:00:00.000Z");
const SEC = 1000;

/** A settled, post-boot loop with nothing going on. */
function restingInput(overrides: Partial<LoopStateInput> = {}): LoopStateInput {
    return {
        nowMs: T0 + 10 * 60 * SEC,
        loopStartMs: T0,
        bootGraceMs: 60 * SEC,
        bootMinMs: 30 * SEC,
        bootDeadlineMs: T0 + 30 * SEC,
        resumePickerActive: false,
        bootComplete: true,
        paneBusy: false,
        paneReady: true,
        paneCompacting: false,
        paneInterrupted: false,
        notLoggedIn: false,
        apiUnreachableSinceMs: null,
        apiUnreachableTtlMs: 120 * SEC,
        noWait: false,
        humanTypingAtMs: null,
        humanTypingTtlMs: 5 * SEC,
        afkMode: "off",
        afkExpiryMs: null,
        idleSinceMs: null,
        wakeInFlightAtMs: null,
        wakeInFlightTtlMs: 2 * SEC,
        busyDeferUntilMs: null,
        inputHotTtlMs: 3 * SEC,
        manualWake: false,
        ...overrides,
    };
}

test("a quiet loop agrees with idle_prompt — nothing to report", () => {
    assert.equal(computeLoopView(restingInput()).phase, "idle");
});

test("a stale busy latch is what the witness exists to catch", () => {
    // `idle_prompt` says the session has been quiet for ~60 s while the
    // pane-scraped latch still claims busy. The contradiction is the finding.
    assert.equal(computeLoopView(restingInput({ paneBusy: true })).phase, "busy");
});

test("boot is not a contradiction — the loop is legitimately not idle yet", () => {
    // Guards against a future widening to `phase !== "idle"`, which would
    // report a mismatch during boot-grace and cry wolf on every startup.
    const v = computeLoopView(restingInput({ nowMs: T0 + 5 * SEC, bootComplete: false, paneReady: false }));
    assert.equal(v.phase, "boot");
    assert.notEqual(v.phase, "busy");
});

/**
 * #1990 — the wake-hold during an API outage, and the one number that was wrong.
 *
 * The hold existed and blocked every wake, manual ones included. It was
 * measured from the START of the outage though, so it expired 120 s in
 * regardless of whether the API was still down — david filed a screenshot of a
 * wake queued behind a live "API unreachable · retrying" banner, and the
 * episode measured that morning ran 5 min 20.
 *
 * Both directions matter here, so both are pinned: the hold has to survive a
 * long outage, AND it still has to expire once the banner stops showing —
 * otherwise a latch left stuck by a scraped detector freezes the loop for good,
 * which is the failure the fail-open exists to prevent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeLoopView } from "./loop-state.js";
import type { LoopStateInput } from "./loop-state.js";

const T0 = Date.parse("2026-09-03T14:00:00.000Z");
const SEC = 1000;
const TTL = 120 * SEC;

function outage(over: Partial<LoopStateInput> = {}): LoopStateInput {
    return {
        nowMs: T0,
        loopStartMs: T0 - 60 * 60 * SEC,
        bootGraceMs: 60 * SEC,
        bootMinMs: 30 * SEC,
        bootDeadlineMs: T0 - 59 * 60 * SEC,
        resumePickerActive: false,
        bootComplete: true,
        paneBusy: false,
        paneReady: true,
        paneCompacting: false,
        paneInterrupted: false,
        notLoggedIn: false,
        apiUnreachableSinceMs: null,
        apiUnreachableSeenMs: null,
        apiUnreachableTtlMs: TTL,
        noWait: false,
        humanTypingAtMs: null,
        humanTypingTtlMs: 5 * SEC,
        afkMode: "off",
        afkExpiryMs: null,
        idleSinceMs: T0 - 60 * SEC,
        wakeInFlightAtMs: null,
        wakeInFlightTtlMs: 2 * SEC,
        busyDeferUntilMs: null,
        inputHotTtlMs: 3 * SEC,
        manualWake: false,
        ...over,
    };
}

test("a five-minute outage still holds at minute four — the reported bug", () => {
    // Banner up since T0-5min and seen a second ago: the old code measured
    // from `since` and had failed open two and a half minutes earlier.
    const v = computeLoopView(outage({
        apiUnreachableSinceMs: T0 - 5 * 60 * SEC,
        apiUnreachableSeenMs: T0 - 1 * SEC,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /API unreachable/);
});

test("the hold expires once the banner has been gone for the TTL — anti-freeze kept", () => {
    const v = computeLoopView(outage({
        apiUnreachableSinceMs: T0 - 60 * 60 * SEC,
        apiUnreachableSeenMs: T0 - TTL - SEC,
    }));
    assert.equal(v.wakeAllowed, true, "a stuck scraped latch must still self-heal");
});

test("it is the LAST sighting that counts, not the first", () => {
    const long = { apiUnreachableSinceMs: T0 - 60 * 60 * SEC };
    assert.equal(computeLoopView(outage({ ...long, apiUnreachableSeenMs: T0 })).wakeAllowed, false);
    assert.equal(computeLoopView(outage({ ...long, apiUnreachableSeenMs: T0 - TTL - SEC })).wakeAllowed, true);
});

test("a state mirrored from a pre-#1990 timer falls back to the outage start", () => {
    // A hook subprocess can hold an older shape; losing the field must degrade
    // to the previous behaviour, never to "no hold at all".
    const v = computeLoopView(outage({
        apiUnreachableSinceMs: T0 - 10 * SEC,
        apiUnreachableSeenMs: null,
    }));
    assert.equal(v.wakeAllowed, false);
});

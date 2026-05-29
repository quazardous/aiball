/**
 * #627 — scenario tests for the central LoopState service. Pure inputs →
 * pure view. No fs, no timers, no claude-loop running. Covers the
 * cross-product of (boot / post-boot) × (AFK off / 10m / ∞) × (typing /
 * not) × (--wait / --no-wait) × wake-gate edges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    canArmAfk10mOnTyping,
    canFireWake,
    canFlipBgFromBoot,
    canPaintStopOnTyping,
    computeLoopView,
    isAfkHeld,
    isAutonomous,
    isBootPhase,
    shouldArmAfk10mOnSettleBoot,
    type LoopStateInput,
} from "./loop-state.js";

const T0 = Date.parse("2026-05-29T17:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;

/** Default input: at T0+0s, fresh boot, no typing, no AFK, no idle marker.
 *  Mirrors the real defaults : 60s boot-grace, 5s typing TTL, 10min
 *  user-grace, 2s wake-in-flight TTL. */
function baseInput(overrides: Partial<LoopStateInput> = {}): LoopStateInput {
    return {
        nowMs: T0,
        loopStartMs: T0,
        bootGraceMs: 60 * SEC,
        resumePickerActive: false,
        bootComplete: false,
        noWait: false,
        humanTypingAtMs: null,
        humanTypingTtlMs: 5 * SEC,
        userTookOverAtMs: null,
        userGraceMs: 10 * MIN,
        afkMode: "off",
        afkExpiryMs: null,
        idleSinceMs: null,
        wakeInFlightAtMs: null,
        wakeInFlightTtlMs: 2 * SEC,
        busyDeferUntilMs: null,
        paneBusy: false,
        paneReady: false,
        manualWake: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
//  Boot-grace phase — bar BG stable yellow regardless of pane content
// ---------------------------------------------------------------------------

test("boot phase under --wait, picker not yet rendered", () => {
    const v = computeLoopView(baseInput({ nowMs: T0 + 5 * SEC }));
    assert.equal(v.phase, "boot");
    assert.equal(v.barWord, "boot");
    assert.equal(v.afkChunk.label, "AFK");
    assert.equal(v.afkChunk.color, "dim");
    assert.equal(v.inBootGrace, true);
    assert.equal(v.wakeAllowed, false);
    // The first failing gate wins — during boot the idle-marker isn't
    // written yet (settleBoot writes it at T+grace), so that reason
    // surfaces before the boot-grace check.
    assert.match(v.wakeSkipReason ?? "", /no idle marker|boot-grace/);
});

test("boot phase with idle marker (rare race) → boot-grace gate wins", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 5 * SEC,
        idleSinceMs: T0 + 4 * SEC,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /boot-grace/);
});

test("boot phase under --no-wait, picker delayed → still boot until T+grace", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 30 * SEC,
        noWait: true,
        paneBusy: false,
        paneReady: true, // claude splash rendered — but boot-grace still wins for phase
    }));
    assert.equal(v.phase, "boot");
    assert.equal(v.barWord, "boot");
    assert.equal(v.inBootGrace, true);
});

test("boot phase: claude shows `esc to interrupt` (transient) → bar still boot", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 10 * SEC,
        paneBusy: true,
    }));
    assert.equal(v.phase, "boot");
    assert.equal(v.barWord, "boot");
});

test("boot phase: typing in resume picker → no stop, no AFK arming", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 15 * SEC,
        humanTypingAtMs: T0 + 14 * SEC,
    }));
    // boot still wins over stop ; consumer (proxy) gates the arm side
    assert.equal(v.barWord, "boot");
    assert.equal(v.afkChunk.label, "AFK");
});

// ---------------------------------------------------------------------------
//  Post-boot transitions — --wait arms 10m, --no-wait stays loop
// ---------------------------------------------------------------------------

test("post-boot --wait + NOT AFK 10m armed → wait jaune + wake skip", () => {
    const start = T0;
    const now = start + 61 * SEC;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 10 * MIN,
        idleSinceMs: now - SEC,
    }));
    assert.equal(v.phase, "idle");
    assert.equal(v.barWord, "wait");
    assert.equal(v.afkChunk.label, "NOT AFK");
    assert.equal(v.afkChunk.color, "yellow");
    assert.equal(v.afkChunk.prefix, "10m");
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /NOT AFK/);
});

test("post-boot --no-wait + AFK off → loop vert + wake allowed", () => {
    const start = T0;
    const now = start + 61 * SEC;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        noWait: true,
        idleSinceMs: now - SEC,
    }));
    assert.equal(v.phase, "idle");
    assert.equal(v.barWord, "loop");
    assert.equal(v.afkChunk.label, "AFK");
    assert.equal(v.afkChunk.color, "dim");
    assert.equal(v.wakeAllowed, true);
    assert.equal(v.wakeSkipReason, null);
});

// ---------------------------------------------------------------------------
//  AFK tristate — F9 cycle behaviour (callers mutate file, service reads it)
// ---------------------------------------------------------------------------

test("F9 from AFK → NOT AFK 10m → bar wait jaune", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 10 * MIN,
        idleSinceMs: now - 5 * SEC,
    }));
    assert.equal(v.barWord, "wait");
    assert.equal(v.afkChunk.label, "NOT AFK");
    assert.equal(v.afkChunk.color, "yellow");
});

test("F9 from NOT AFK 10m → NOT AFK ∞ → bar wait rouge", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_inf",
        idleSinceMs: now,
    }));
    assert.equal(v.barWord, "wait");
    assert.equal(v.afkChunk.label, "NOT AFK");
    assert.equal(v.afkChunk.color, "red");
    assert.equal(v.afkChunk.prefix, "∞");
});

test("F9 from NOT AFK ∞ → AFK → bar loop vert", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "off",
        idleSinceMs: now,
    }));
    assert.equal(v.barWord, "loop");
    assert.equal(v.afkChunk.label, "AFK");
});

// ---------------------------------------------------------------------------
//  AFK 10m countdown semantics
// ---------------------------------------------------------------------------

test("AFK 10m countdown 9m left → `9m NOT AFK:F9`", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 9 * MIN,
        idleSinceMs: now,
    }));
    assert.equal(v.afkChunk.prefix, "9m");
});

test("AFK 10m countdown 30s left → `30s NOT AFK:F9`", () => {
    const start = T0;
    const now = start + 9 * MIN + 30 * SEC;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 30 * SEC,
        idleSinceMs: now,
    }));
    assert.equal(v.afkChunk.prefix, "30s");
});

test("AFK 10m auto-expires → bar loop vert + wake allowed", () => {
    const start = T0;
    const now = start + 15 * MIN; // past 10m expiry
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: start + 11 * MIN, // expired 4 minutes ago
        idleSinceMs: now - 5 * SEC,
    }));
    assert.equal(v.barWord, "loop");
    assert.equal(v.afkChunk.label, "AFK");
    assert.equal(v.afkChunk.color, "dim");
    assert.equal(v.wakeAllowed, true);
});

// ---------------------------------------------------------------------------
//  Typing precedence
// ---------------------------------------------------------------------------

test("typing post-boot → stop red (overrides AFK 10m wait word)", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        humanTypingAtMs: now - SEC,
        afkMode: "wait_10m",
        afkExpiryMs: now + 5 * MIN,
        idleSinceMs: now - 2 * SEC,
    }));
    assert.equal(v.barWord, "stop");
    assert.equal(v.afkChunk.label, "NOT AFK"); // chunk unaffected by typing
});

test("typing TTL expired (>5s ago) → bar reverts to AFK-driven state", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        humanTypingAtMs: now - 10 * SEC, // 10s ago, past 5s TTL
        afkMode: "wait_10m",
        afkExpiryMs: now + 5 * MIN,
        idleSinceMs: now,
    }));
    assert.equal(v.barWord, "wait");
});

// ---------------------------------------------------------------------------
//  Wake-gate cascade — each gate skips with a distinct reason
// ---------------------------------------------------------------------------

test("no idle marker → wake skipped (claude busy or pre-boot)", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 5 * MIN,
        loopStartMs: T0,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /no idle marker/);
});

test("user-grace fresh → wake skipped", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        userTookOverAtMs: now - 2 * MIN, // within 10min user-grace
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /user-grace/);
});

test("wake-in-flight fresh → wake skipped (counter coalesce)", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        wakeInFlightAtMs: now - SEC,
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /wake already in flight/);
});

test("busy-defer active → wake skipped", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        busyDeferUntilMs: now + 3 * SEC,
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /busy-defer/);
});

test("pane busy (esc to interrupt) → wake skipped", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        paneBusy: true,
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /esc to interrupt/);
});

test("manual wake bypasses user-grace + AFK + defer, but NOT idle-marker", () => {
    const start = T0;
    const now = start + 5 * MIN;
    // With idle marker : manual wake fires through every other gate.
    const allowed = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        manualWake: true,
        userTookOverAtMs: now - SEC,
        afkMode: "wait_inf",
        busyDeferUntilMs: now + MIN,
        wakeInFlightAtMs: now - SEC,
        idleSinceMs: now,
    }));
    assert.equal(allowed.wakeAllowed, true);
    // Without idle marker : even manual is held off.
    const blocked = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        manualWake: true,
        idleSinceMs: null,
    }));
    assert.equal(blocked.wakeAllowed, false);
    assert.match(blocked.wakeSkipReason ?? "", /no idle marker/);
});

// ---------------------------------------------------------------------------
//  Phase computation — busy / idle / boot interplay
// ---------------------------------------------------------------------------

test("post-boot + pane busy → phase = busy", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        paneBusy: true,
        idleSinceMs: now,
    }));
    assert.equal(v.phase, "busy");
});

test("post-boot + idle → phase = idle", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        idleSinceMs: now,
    }));
    assert.equal(v.phase, "idle");
});

// ---------------------------------------------------------------------------
//  Edge cases — empty file, expired-but-present, zero boot-grace
// ---------------------------------------------------------------------------

test("zero boot-grace → never in boot phase", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0,
        loopStartMs: T0,
        bootGraceMs: 0,
        idleSinceMs: T0,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.phase, "idle");
    assert.equal(v.barWord, "loop");
});

test("AFK wait_10m with null expiry → treated as inactive", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: null,
        idleSinceMs: now,
    }));
    assert.equal(v.barWord, "loop"); // not active
    assert.equal(v.afkChunk.label, "AFK"); // dim
});

test("countdown rounds up (29.4s → `30s`, not `29s`)", () => {
    const start = T0;
    const now = start + MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 29.4 * SEC,
        idleSinceMs: now,
    }));
    assert.equal(v.afkChunk.prefix, "30s");
});

test("countdown never reads `0s` (clamped to 1s)", () => {
    const start = T0;
    const now = start + 10 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        afkMode: "wait_10m",
        afkExpiryMs: now + 100, // 100ms remaining
        idleSinceMs: now,
    }));
    assert.equal(v.afkChunk.prefix, "1s");
});

test("wake-in-flight stale (>TTL) → no longer gates", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        wakeInFlightAtMs: now - 10 * SEC, // way past 2s TTL
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, true);
});

test("busy-defer with deadline in the past → no longer gates", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        busyDeferUntilMs: now - SEC, // expired 1s ago
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, true);
});

// ---------------------------------------------------------------------------
//  Semantic helpers — canX / isX (david `vnhdku`)
// ---------------------------------------------------------------------------

test("canArmAfk10mOnTyping : false in boot-grace", () => {
    const input = baseInput({ nowMs: T0 + 10 * SEC });
    assert.equal(canArmAfk10mOnTyping(input), false);
});

test("canArmAfk10mOnTyping : false in NOT AFK ∞ (only F9 releases)", () => {
    const input = baseInput({
        nowMs: T0 + 5 * MIN,
        loopStartMs: T0,
        afkMode: "wait_inf",
    });
    assert.equal(canArmAfk10mOnTyping(input), false);
});

test("canArmAfk10mOnTyping : true post-boot in AFK off (arms fresh 10m)", () => {
    const input = baseInput({
        nowMs: T0 + 5 * MIN,
        loopStartMs: T0,
    });
    assert.equal(canArmAfk10mOnTyping(input), true);
});

test("canArmAfk10mOnTyping : true post-boot in NOT AFK 10m (refreshes)", () => {
    const now = T0 + 5 * MIN;
    const input = baseInput({
        nowMs: now,
        loopStartMs: T0,
        afkMode: "wait_10m",
        afkExpiryMs: now + 5 * MIN,
    });
    assert.equal(canArmAfk10mOnTyping(input), true);
});

test("canPaintStopOnTyping : false in boot-grace, true after", () => {
    assert.equal(canPaintStopOnTyping(baseInput({ nowMs: T0 + 5 * SEC })), false);
    assert.equal(canPaintStopOnTyping(baseInput({ nowMs: T0 + 90 * SEC, loopStartMs: T0 })), true);
});

test("canFlipBgFromBoot : false in boot-grace, true after", () => {
    assert.equal(canFlipBgFromBoot(baseInput({ nowMs: T0 + 5 * SEC })), false);
    assert.equal(canFlipBgFromBoot(baseInput({ nowMs: T0 + 90 * SEC, loopStartMs: T0 })), true);
});

test("shouldArmAfk10mOnSettleBoot : true under --wait, false under --no-wait", () => {
    assert.equal(shouldArmAfk10mOnSettleBoot({ noWait: false }), true);
    assert.equal(shouldArmAfk10mOnSettleBoot({ noWait: true }), false);
});

test("canFireWake : mirrors view.wakeAllowed", () => {
    const view = computeLoopView(baseInput({
        nowMs: T0 + 2 * MIN,
        loopStartMs: T0,
        idleSinceMs: T0 + 119 * SEC,
    }));
    assert.equal(canFireWake(view), view.wakeAllowed);
});

test("isAfkHeld : true under NOT AFK 10m and ∞, false otherwise", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const off = computeLoopView(baseInput({ nowMs: now, loopStartMs: start, idleSinceMs: now }));
    const wait10m = computeLoopView(baseInput({
        nowMs: now, loopStartMs: start, idleSinceMs: now,
        afkMode: "wait_10m", afkExpiryMs: now + 5 * MIN,
    }));
    const waitInf = computeLoopView(baseInput({
        nowMs: now, loopStartMs: start, idleSinceMs: now, afkMode: "wait_inf",
    }));
    assert.equal(isAfkHeld(off), false);
    assert.equal(isAfkHeld(wait10m), true);
    assert.equal(isAfkHeld(waitInf), true);
});

test("isAutonomous : true only when bar word is `loop`", () => {
    const start = T0;
    const now = start + 2 * MIN;
    const loop = computeLoopView(baseInput({ nowMs: now, loopStartMs: start, idleSinceMs: now }));
    const stop = computeLoopView(baseInput({
        nowMs: now, loopStartMs: start, idleSinceMs: now,
        humanTypingAtMs: now - SEC,
    }));
    const wait = computeLoopView(baseInput({
        nowMs: now, loopStartMs: start, idleSinceMs: now,
        afkMode: "wait_inf",
    }));
    assert.equal(isAutonomous(loop), true);
    assert.equal(isAutonomous(stop), false);
    assert.equal(isAutonomous(wait), false);
});

test("isBootPhase : tracks phase === 'boot'", () => {
    const boot = computeLoopView(baseInput({ nowMs: T0 + 5 * SEC }));
    const idle = computeLoopView(baseInput({
        nowMs: T0 + 90 * SEC, loopStartMs: T0, idleSinceMs: T0 + 89 * SEC, bootComplete: true,
    }));
    assert.equal(isBootPhase(boot), true);
    assert.equal(isBootPhase(idle), false);
});

// ---------------------------------------------------------------------------
//  Resume picker awareness (#624 david `8pwvm3`) — explicit signals
//  stretch / end the boot phase, time cap is fail-safe only
// ---------------------------------------------------------------------------

test("resume picker active 10 min in → still in boot (no time cap)", () => {
    const start = T0;
    const now = start + 10 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootGraceMs: 5 * MIN, // legacy cap < elapsed time
        resumePickerActive: true,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
    assert.equal(v.phase, "boot");
});

test("bootComplete signal flips boot OFF immediately, regardless of time cap", () => {
    const start = T0;
    const now = start + 5 * SEC; // way inside time cap
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: now,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.barWord, "loop");
});

test("picker active wins over bootComplete (re-entered picker race)", () => {
    // Defensive : if both markers somehow exist, picker active takes
    // priority — the user is interacting with a picker right now.
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        resumePickerActive: true,
        bootComplete: true,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
});

test("no signal + time cap exceeded → boot ends as safety", () => {
    // Hook crashed / never ran → fall back to the time-based cap.
    const start = T0;
    const now = start + 6 * MIN; // past 5 min cap
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootGraceMs: 5 * MIN,
        idleSinceMs: now,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.barWord, "loop");
});

test("no signal + within time cap → still boot (initial loading window)", () => {
    const start = T0;
    const now = start + 30 * SEC;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootGraceMs: 5 * MIN,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
});

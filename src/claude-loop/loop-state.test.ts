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
    inputHotAgeMs,
    isAfkHeld,
    isAutonomous,
    isBootPhase,
    isInputHot,
    isReallyBusy,
    LoopStateBus,
    shouldArmAfk10mOnSettleBoot,
    shouldPollFast,
    type LoopStateInput,
} from "./loop-state.js";

const T0 = Date.parse("2026-05-29T17:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;

/** Default input: at T0+0s, fresh boot, no typing, no AFK, no idle marker.
 *  Mirrors the real defaults : 60s boot-grace, 5s typing TTL, 10min
 *  user-grace, 2s wake-in-flight TTL. */
function baseInput(overrides: Partial<LoopStateInput> = {}): LoopStateInput {
    // #629 david `2hwuan` : new default = post-boot, claude ready. The OLD
    // baseInput defaulted to inside-boot via no signals + time-cap exit ;
    // the new model has no time-cap exit (settleBoot in timer.ts seals
    // bootComplete via setResumePicker). Tests that need boot phase set
    // `bootComplete: false` + `paneReady: false` explicitly, or rely on
    // the 30s floor (nowMs within bootMinMs of loopStartMs).
    return {
        nowMs: T0,
        loopStartMs: T0,
        bootGraceMs: 60 * SEC,
        bootMinMs: 30 * SEC,
        resumePickerActive: false,
        bootComplete: true,
        paneBusy: false,
        paneReady: true,
        paneCompacting: false,
        paneInterrupted: false,
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
        // #722 — input-hot TTL (3s default in autopoll/config).
        inputHotTtlMs: 3 * SEC,
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
    assert.match(v.wakeSkipReason ?? "", /no idle marker|boot floor|boot phase|boot — /);
});

test("boot phase with idle marker (rare race) → boot-grace gate wins", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 5 * SEC,
        idleSinceMs: T0 + 4 * SEC,
    }));
    assert.equal(v.wakeAllowed, false);
    // #629 — at T+5s with 30s floor, the inviolable floor branch fires first.
    assert.match(v.wakeSkipReason ?? "", /boot floor/);
});

test("boot phase under --no-wait + picker active → boot stretches (picker pre-settle)", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0 + 30 * SEC,
        noWait: true,
        paneBusy: false,
        paneReady: false,
        bootComplete: false,    // #629 — pre-settle
        resumePickerActive: true,
    }));
    assert.equal(v.phase, "boot");
    assert.equal(v.barWord, "boot");
    assert.equal(v.inBootGrace, true);
});

// ---------------------------------------------------------------------------
//  LoopStateBus (#630 david `e4ejra` / `d59zge`) — event diffs over the
//  pure compute layer
// ---------------------------------------------------------------------------

test("LoopStateBus: first update doesn't emit (no prior view to diff)", () => {
    const bus = new LoopStateBus();
    let calls = 0;
    bus.on("transition", () => calls++);
    bus.update(baseInput());
    assert.equal(calls, 0);
});

test("LoopStateBus: second update with same view → no emit", () => {
    const bus = new LoopStateBus();
    bus.update(baseInput());
    let calls = 0;
    bus.on("transition", () => calls++);
    bus.update(baseInput());
    assert.equal(calls, 0);
});

test("LoopStateBus: bootEnded fires when inBootGrace flips true→false", () => {
    // #629 — past the inviolable 30s floor for bootComplete to take effect.
    const bus = new LoopStateBus();
    bus.update(baseInput({
        nowMs: T0 + 45 * SEC, loopStartMs: T0,
        bootComplete: false, paneReady: false,  // explicitly in boot
    }));
    let fired = false;
    bus.on("bootEnded", () => { fired = true; });
    bus.update(baseInput({
        nowMs: T0 + 45 * SEC,
        loopStartMs: T0,
        bootComplete: true,
        idleSinceMs: T0 + 45 * SEC,
    }));
    assert.equal(fired, true);
});

test("LoopStateBus: afkArmed10m fires on off → 10m", () => {
    const bus = new LoopStateBus();
    const start = T0;
    const now = start + 5 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
    }));
    let expiry = 0;
    bus.on("afkArmed10m", (e) => { expiry = e; });
    const newExpiry = now + 10 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        afkMode: "wait_10m", afkExpiryMs: newExpiry,
    }));
    assert.equal(expiry, newExpiry);
});

test("LoopStateBus: afkArmedInf fires on 10m → ∞", () => {
    const bus = new LoopStateBus();
    const start = T0;
    const now = start + 5 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        afkMode: "wait_10m", afkExpiryMs: now + 5 * MIN,
    }));
    let fired = false;
    bus.on("afkArmedInf", () => { fired = true; });
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        afkMode: "wait_inf",
    }));
    assert.equal(fired, true);
});

test("LoopStateBus: afkCleared fires on ∞ → off", () => {
    const bus = new LoopStateBus();
    const start = T0;
    const now = start + 5 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        afkMode: "wait_inf",
    }));
    let fired = false;
    bus.on("afkCleared", () => { fired = true; });
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
    }));
    assert.equal(fired, true);
});

test("LoopStateBus: wakeBecameAllowed fires when gate flips closed→open", () => {
    const bus = new LoopStateBus();
    const start = T0;
    const now = start + 5 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        afkMode: "wait_inf", // blocks wake
    }));
    let view = null as null | { wakeAllowed: boolean };
    bus.on("wakeBecameAllowed", (v) => { view = v; });
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        // afkMode default off → wake opens
    }));
    assert.notEqual(view, null);
    assert.equal(view!.wakeAllowed, true);
});

test("LoopStateBus: wakeBecameBlocked fires on open→closed + reason passed", () => {
    const bus = new LoopStateBus();
    const start = T0;
    const now = start + 5 * MIN;
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
    }));
    let reason = "";
    bus.on("wakeBecameBlocked", (r) => { reason = r; });
    bus.update(baseInput({
        nowMs: now, loopStartMs: start, bootComplete: true, idleSinceMs: now,
        paneBusy: true,
    }));
    assert.match(reason, /esc to interrupt/);
});

test("LoopStateBus: pickerOpened / pickerClosed fire on resumePickerActive flips", () => {
    const bus = new LoopStateBus();
    bus.update(baseInput());
    let opened = false, closed = false;
    bus.on("pickerOpened", () => { opened = true; });
    bus.on("pickerClosed", () => { closed = true; });
    bus.update(baseInput({ resumePickerActive: true }));
    assert.equal(opened, true);
    assert.equal(closed, false);
    bus.update(baseInput({ resumePickerActive: false, bootComplete: true, idleSinceMs: T0 }));
    assert.equal(closed, true);
});

test("LoopStateBus: barWordChanged + phaseChanged fire independently", () => {
    const bus = new LoopStateBus();
    const start = T0;
    // #629 — past 30s floor so bootComplete can take effect.
    bus.update(baseInput({
        nowMs: start + 45 * SEC, loopStartMs: start,
        bootComplete: false, paneReady: false,  // explicitly in boot
    }));
    const words: [string, string][] = [];
    const phases: [string, string][] = [];
    bus.on("barWordChanged", (p, n) => words.push([p, n]));
    bus.on("phaseChanged", (p, n) => phases.push([p, n]));
    bus.update(baseInput({
        nowMs: start + 45 * SEC,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: start + 45 * SEC,
    }));
    assert.deepEqual(words, [["boot", "loop"]]);
    assert.deepEqual(phases, [["boot", "idle"]]);
});

test("LoopStateBus: unsubscribe stops further calls", () => {
    const bus = new LoopStateBus();
    bus.update(baseInput()); // boot view
    let calls = 0;
    const off = bus.on("transition", () => calls++);
    // Flip bootComplete → view changes (boot → idle, loop word)
    bus.update(baseInput({ bootComplete: true, idleSinceMs: T0 }));
    assert.equal(calls, 1);
    off();
    bus.update(baseInput({ bootComplete: true, idleSinceMs: T0, paneBusy: true }));
    assert.equal(calls, 1); // not incremented
});

test("LoopStateBus: listener throw doesn't break the bus", () => {
    const bus = new LoopStateBus();
    bus.update(baseInput());
    bus.on("transition", () => { throw new Error("boom"); });
    let secondCalled = false;
    bus.on("transition", () => { secondCalled = true; });
    bus.update(baseInput({ bootComplete: true, idleSinceMs: T0 }));
    assert.equal(secondCalled, true);
});

test("LoopStateBus: current() returns null until first update, then the last view", () => {
    const bus = new LoopStateBus();
    assert.equal(bus.current(), null);
    bus.update(baseInput());
    assert.notEqual(bus.current(), null);
    assert.equal(bus.current()!.barWord, "boot");
});

test("paneReady=true (post-picker, no transient text) → boot ends", () => {
    // #629 david `44ca88` : refreshPaneMarkers filters out picker UI +
    // `Resuming…` / `Compacting…` from paneReady. When paneReady becomes
    // true, claude IS at the prompt past every transient state.
    const v = computeLoopView(baseInput({
        nowMs: T0 + 30 * SEC,
        paneReady: true,
        idleSinceMs: T0 + 30 * SEC,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.barWord, "loop");
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

test("zero boot-grace + zero floor + paneReady → never in boot phase", () => {
    const v = computeLoopView(baseInput({
        nowMs: T0,
        loopStartMs: T0,
        bootGraceMs: 0,
        bootMinMs: 0,
        bootComplete: true,   // #629 sealed
        paneReady: true,
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
    // #629 : post-floor requires bootComplete (or paneReady) to leave boot.
    assert.equal(canPaintStopOnTyping(baseInput({
        nowMs: T0 + 90 * SEC, loopStartMs: T0, bootComplete: true,
    })), true);
});

test("canFlipBgFromBoot : false in boot-grace, true after", () => {
    assert.equal(canFlipBgFromBoot(baseInput({ nowMs: T0 + 5 * SEC })), false);
    assert.equal(canFlipBgFromBoot(baseInput({
        nowMs: T0 + 90 * SEC, loopStartMs: T0, bootComplete: true,
    })), true);
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
        bootComplete: false,  // #629 — pre-settle
        paneReady: false,
        resumePickerActive: true,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
    assert.equal(v.phase, "boot");
});

test("bootComplete signal flips boot OFF post-floor (floor still wins inside)", () => {
    // #629 david `2hwuan` : floor is INVIOLABLE — bootComplete cannot
    // short-circuit it. Test both sides of the floor.
    const start = T0;
    // Inside floor (T+5s, default 30s floor) : still boot despite bootComplete.
    const inside = computeLoopView(baseInput({
        nowMs: start + 5 * SEC,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: start,
    }));
    assert.equal(inside.inBootGrace, true);
    assert.equal(inside.barWord, "boot");
    // Past floor (T+45s) : bootComplete flips out of boot.
    const past = computeLoopView(baseInput({
        nowMs: start + 45 * SEC,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: start + 44 * SEC,
    }));
    assert.equal(past.inBootGrace, false);
    assert.equal(past.barWord, "loop");
});

test("bootComplete wins over picker post-floor (no re-entry once sealed)", () => {
    // #629 david `rjd3x4` : once bootComplete is sealed, NOTHING can
    // re-enter boot — not picker (defensive race) nor paneCompacting
    // (mid-session /compact). The sealed marker is authoritative.
    const start = T0;
    const now = start + 2 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        resumePickerActive: true,
        bootComplete: true,
        idleSinceMs: now,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.barWord, "loop");
});

test("paneReady=true post-floor → boot ends (probe-driven settle)", () => {
    // #629 : pure-compute settles via paneReady when no bootComplete signal
    // yet. The bus's bootEnded event handler in timer.ts seals bootComplete
    // immediately after — this test exercises the first transition.
    const start = T0;
    const now = start + 45 * SEC; // past 30s floor
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        paneReady: true,
        idleSinceMs: now,
    }));
    assert.equal(v.inBootGrace, false);
    assert.equal(v.barWord, "loop");
});

test("paneReady=false post-floor → still boot (claude not at prompt yet)", () => {
    // The pane probe writes paneReady=false while the splash / loading is
    // visible. State stays boot until probe sees the prompt.
    const start = T0;
    const now = start + 45 * SEC;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: false,    // #629 — pre-settle, no hook signal yet
        paneReady: false,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
});

test("paneCompacting stretches boot only PRE-settle (post-resume compact)", () => {
    const start = T0;
    const now = start + 45 * SEC;
    // Pre-settle : compacting after resume → boot stretches.
    const pre = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        paneCompacting: true,
        paneReady: false,
        bootComplete: false,
    }));
    assert.equal(pre.inBootGrace, true);
    assert.equal(pre.barWord, "boot");
    // Post-settle : mid-session /compact does NOT re-enter boot.
    const post = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        paneCompacting: true,
        paneReady: true,
        bootComplete: true,   // sealed by earlier bootEnded
        paneBusy: true,        // claude is in a turn doing the compaction
        idleSinceMs: now,
    }));
    assert.equal(post.inBootGrace, false);
    assert.equal(post.phase, "busy");
    assert.equal(post.barWord, "loop");
});

test("floor inviolable : no signal can leave boot before bootMinMs elapses", () => {
    // #629 david `2hwuan` : floor 30s — every "we're ready" signal is
    // ignored inside the floor. Covers Bug 1 (loop/boot flicker startup)
    // and Bug 2 (BG gray during picker before hook fires).
    const start = T0;
    const now = start + 15 * SEC; // inside 30s floor
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        paneReady: true,
        idleSinceMs: now,
    }));
    assert.equal(v.inBootGrace, true);
    assert.equal(v.barWord, "boot");
});

// ---------------------------------------------------------------------------
//  Pane-* signals as markers (#624 david `62ys4g`) — pane is external,
//  so it gets the same setter pattern as setResumePicker
// ---------------------------------------------------------------------------

test("pane compacting → wake skipped (internal busy)", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: now,
        paneCompacting: true,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /compact/);
});

test("pane interrupted → does NOT gate wake (decorative)", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: now,
        paneInterrupted: true,
    }));
    // `interrupted` is just a bar tag, not a gate — wake should still fire
    // (the user explicitly ESCaped ; the next wake re-engages claude).
    assert.equal(v.wakeAllowed, true);
});

test("pane busy + paneCompacting both true → busy reason wins (first checked)", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: now,
        paneBusy: true,
        paneCompacting: true,
    }));
    assert.equal(v.wakeAllowed, false);
    assert.match(v.wakeSkipReason ?? "", /esc to interrupt/);
});

test("pane busy=false, compacting=false → wake allowed when nothing else gates", () => {
    const start = T0;
    const now = start + 5 * MIN;
    const v = computeLoopView(baseInput({
        nowMs: now,
        loopStartMs: start,
        bootComplete: true,
        idleSinceMs: now,
    }));
    assert.equal(v.wakeAllowed, true);
});

// #714 — `isReallyBusy(input)` semantic helper. Canonical answer to
// "is claude really busy ?" via simple disjunction of the two pane-
// derived file markers. Nuances (typing-in-picker, AskUserQuestion,
// etc.) come in V3 (#716).

test("isReallyBusy : false when both pane-busy and pane-compacting are false", () => {
    assert.equal(isReallyBusy(baseInput({ paneBusy: false, paneCompacting: false })), false);
});

test("isReallyBusy : true when only pane-busy is set", () => {
    assert.equal(isReallyBusy(baseInput({ paneBusy: true, paneCompacting: false })), true);
});

test("isReallyBusy : true when only pane-compacting is set", () => {
    assert.equal(isReallyBusy(baseInput({ paneBusy: false, paneCompacting: true })), true);
});

test("isReallyBusy : true when both are set", () => {
    assert.equal(isReallyBusy(baseInput({ paneBusy: true, paneCompacting: true })), true);
});

// #714 — `busy` bus event. Single signal with `(next, prev)` aligned
// with `phaseChanged`/`barWordChanged`. Subscribers (pane-probe cadence
// in timer.ts) arm/disarm work off the boolean.

test("LoopStateBus.busy : idle → busy emits busy(true, false)", () => {
    const bus = new LoopStateBus();
    const calls: Array<[boolean, boolean]> = [];
    bus.on("busy", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ paneBusy: false, paneCompacting: false }));
    bus.update(baseInput({ paneBusy: true, paneCompacting: false }));
    assert.deepEqual(calls, [[true, false]]);
});

test("LoopStateBus.busy : busy → idle emits busy(false, true)", () => {
    // First update with busy=true also fires busy(true, false) via the
    // first-update chicken-and-egg fix ; the test starts from a fresh
    // idle baseline to isolate the transition.
    const bus = new LoopStateBus();
    bus.update(baseInput({ paneBusy: false, paneCompacting: false }));
    const calls: Array<[boolean, boolean]> = [];
    bus.on("busy", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ paneBusy: true, paneCompacting: false }));
    bus.update(baseInput({ paneBusy: false, paneCompacting: false }));
    assert.deepEqual(calls, [[true, false], [false, true]]);
});

test("LoopStateBus.busy : busy → busy (no transition) emits nothing", () => {
    // Seed with the first busy update (subscribe AFTER) so only the
    // intra-busy stability is observed.
    const bus = new LoopStateBus();
    bus.update(baseInput({ paneBusy: true, paneCompacting: false }));
    const calls: Array<[boolean, boolean]> = [];
    bus.on("busy", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ paneBusy: true, paneCompacting: false }));
    bus.update(baseInput({ paneBusy: false, paneCompacting: true })); // still busy via compacting
    assert.deepEqual(calls, []);
});

test("LoopStateBus.busy : first update with busy input emits busy(true, false)", () => {
    // Chicken-and-egg : if claude is already busy at the very first
    // bus.update(), the consumer needs the event to arm the probe.
    // Without this, the probe would never fire because the first
    // bus.update() historically emitted no events (no prior view).
    const bus = new LoopStateBus();
    const calls: Array<[boolean, boolean]> = [];
    bus.on("busy", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ paneBusy: true, paneCompacting: false }));
    assert.deepEqual(calls, [[true, false]]);
});

test("LoopStateBus.busy : first update with idle input emits nothing", () => {
    const bus = new LoopStateBus();
    const calls: Array<[boolean, boolean]> = [];
    bus.on("busy", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ paneBusy: false, paneCompacting: false }));
    assert.deepEqual(calls, []);
});

// #722 — `inputHotAgeMs(input)` + `isInputHot(input)` semantic helpers.
// Pure observable derived from `humanTypingAtMs` + `inputHotTtlMs`.

test("inputHotAgeMs : null when no keystroke observed", () => {
    assert.equal(inputHotAgeMs(baseInput({ humanTypingAtMs: null })), null);
});

test("inputHotAgeMs : delta from now", () => {
    const now = T0 + 10 * SEC;
    assert.equal(inputHotAgeMs(baseInput({ nowMs: now, humanTypingAtMs: now - 500 })), 500);
});

test("isInputHot : false when no keystroke observed", () => {
    assert.equal(isInputHot(baseInput({ humanTypingAtMs: null })), false);
});

test("isInputHot : true inside the TTL window", () => {
    const now = T0 + 10 * SEC;
    assert.equal(isInputHot(baseInput({
        nowMs: now,
        humanTypingAtMs: now - 1000, // 1s ago < 3s TTL
        inputHotTtlMs: 3 * SEC,
    })), true);
});

test("isInputHot : false past the TTL window", () => {
    const now = T0 + 10 * SEC;
    assert.equal(isInputHot(baseInput({
        nowMs: now,
        humanTypingAtMs: now - 5 * SEC, // 5s ago > 3s TTL
        inputHotTtlMs: 3 * SEC,
    })), false);
});

test("LoopStateBus.inputHot : cold → hot emits inputHot(true, false)", () => {
    const bus = new LoopStateBus();
    const now = T0 + 10 * SEC;
    bus.update(baseInput({ nowMs: now, humanTypingAtMs: null }));
    const calls: Array<[boolean, boolean]> = [];
    bus.on("inputHot", (next, prev) => { calls.push([next, prev]); });
    bus.update(baseInput({ nowMs: now + 100, humanTypingAtMs: now + 50 }));
    assert.deepEqual(calls, [[true, false]]);
});

test("LoopStateBus.inputHot : hot → cold emits inputHot(false, true) when TTL expires", () => {
    const bus = new LoopStateBus();
    const t0 = T0 + 10 * SEC;
    bus.update(baseInput({ nowMs: t0, humanTypingAtMs: t0 - 100, inputHotTtlMs: 3 * SEC }));
    const calls: Array<[boolean, boolean]> = [];
    bus.on("inputHot", (next, prev) => { calls.push([next, prev]); });
    // Same humanTypingAtMs ; nowMs advances past TTL → hot becomes cold.
    bus.update(baseInput({ nowMs: t0 + 5 * SEC, humanTypingAtMs: t0 - 100, inputHotTtlMs: 3 * SEC }));
    assert.deepEqual(calls, [[false, true]]);
});

test("LoopStateBus.inputHot : first update with hot input emits inputHot(true, false)", () => {
    const bus = new LoopStateBus();
    const calls: Array<[boolean, boolean]> = [];
    bus.on("inputHot", (next, prev) => { calls.push([next, prev]); });
    const now = T0 + 10 * SEC;
    bus.update(baseInput({ nowMs: now, humanTypingAtMs: now - 100 }));
    assert.deepEqual(calls, [[true, false]]);
});

// #722 — `shouldPollFast(input)` aggregator + `pollFast` bus event.
// OR of {boot, busy, input-hot}.

test("shouldPollFast : false when idle / post-boot / no input", () => {
    // Past bootMinMs (30s floor) so isInBootGrace = false.
    assert.equal(shouldPollFast(baseInput({
        nowMs: T0 + 5 * MIN,
        loopStartMs: T0,
    })), false);
});

test("shouldPollFast : true in boot phase", () => {
    // Boot-floor (within bootMinMs of loopStartMs) — guaranteed boot.
    assert.equal(shouldPollFast(baseInput({
        nowMs: T0 + 1 * SEC,
        loopStartMs: T0,
    })), true);
});

test("shouldPollFast : true when busy (paneBusy)", () => {
    assert.equal(shouldPollFast(baseInput({
        nowMs: T0 + 5 * MIN, loopStartMs: T0, paneBusy: true,
    })), true);
});

test("shouldPollFast : true when compacting", () => {
    assert.equal(shouldPollFast(baseInput({
        nowMs: T0 + 5 * MIN, loopStartMs: T0, paneCompacting: true,
    })), true);
});

test("shouldPollFast : true when input-hot", () => {
    const now = T0 + 5 * MIN;
    assert.equal(shouldPollFast(baseInput({
        nowMs: now,
        loopStartMs: T0,
        humanTypingAtMs: now - 500,
    })), true);
});

test("LoopStateBus.pollFast : transitions on input-hot toggle (post-boot, idle)", () => {
    const bus = new LoopStateBus();
    const t0 = T0 + 5 * MIN; // past bootMinMs (30s)
    // Idle baseline post-boot.
    bus.update(baseInput({ nowMs: t0, loopStartMs: T0, humanTypingAtMs: null }));
    const calls: Array<[boolean, boolean]> = [];
    bus.on("pollFast", (next, prev) => { calls.push([next, prev]); });
    // Keystroke → input-hot → poll-fast true.
    bus.update(baseInput({ nowMs: t0 + 100, loopStartMs: T0, humanTypingAtMs: t0 + 50 }));
    // TTL expires → poll-fast false.
    bus.update(baseInput({ nowMs: t0 + 5 * SEC, loopStartMs: T0, humanTypingAtMs: t0 + 50, inputHotTtlMs: 3 * SEC }));
    assert.deepEqual(calls, [[true, false], [false, true]]);
});

test("LoopStateBus.pollFast : first update emits pollFast(true, false) when fast at boot", () => {
    const bus = new LoopStateBus();
    const calls: Array<[boolean, boolean]> = [];
    bus.on("pollFast", (next, prev) => { calls.push([next, prev]); });
    // Boot phase first input → shouldPollFast true → emits.
    bus.update(baseInput({ nowMs: T0 + 1 * SEC, loopStartMs: T0 }));
    assert.deepEqual(calls, [[true, false]]);
});

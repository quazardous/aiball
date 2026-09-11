/**
 * #2311 — a manual wake (`claude-loop wake`) must stop at the screens that stop
 * every wake. The gate always said so (`computeWakeGate`), but `tryWakeInner`
 * skipped the loop view whenever the wake was manual, so a manual wake typed
 * Enter into the trust dialog — which picks "No, exit" and quits claude — and
 * woke a logged-out or offline claude.
 *
 * Two layers are pinned: the verdict `tryWakeInner` acts on (pure), and the
 * kernel asking for it on every wake. The kernel cannot be imported in a test
 * (importing it boots the loop), so that second check reads its source.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { wakeViewVerdict, type LoopStateInput } from "./loop-state.js";

const T0 = Date.parse("2026-09-11T14:00:00.000Z");
const SEC = 1000;

/** A settled, idle loop where every wake would pass. */
function input(over: Partial<LoopStateInput> = {}): LoopStateInput {
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
        trustDialog: false,
        apiUnreachableSinceMs: null,
        apiUnreachableSeenMs: null,
        apiUnreachableTtlMs: 120 * SEC,
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

const BLOCK_EVERY_WAKE: [string, Partial<LoopStateInput>][] = [
    ["not logged in", { notLoggedIn: true }],
    ["trust dialog", { trustDialog: true }],
    ["API unreachable", { apiUnreachableSinceMs: T0 - 10 * SEC, apiUnreachableSeenMs: T0 - SEC }],
];

const HUMAN_OVERRIDABLE: [string, Partial<LoopStateInput>][] = [
    ["human typing", { humanTypingAtMs: T0 - SEC }],
    ["presence hold", { afkMode: "wait_inf" }],
    ["busy-defer", { busyDeferUntilMs: T0 + 5 * SEC }],
    ["boot", { loopStartMs: T0 - 5 * SEC, bootComplete: false, bootDeadlineMs: T0 + 30 * SEC }],
];

test("the fixture is a loop where any wake passes", () => {
    assert.deepEqual(wakeViewVerdict(input(), false), { proceed: true, reason: null, panicBypass: false });
});

test("a manual wake stops at the screens that stop every wake", () => {
    for (const [name, over] of BLOCK_EVERY_WAKE) {
        const v = wakeViewVerdict(input({ manualWake: true, ...over }), false);
        assert.equal(v.proceed, false, name);
        assert.equal(v.panicBypass, false, name);
    }
});

test("a manual wake still passes what a human asks to override, never a busy claude", () => {
    for (const [name, over] of HUMAN_OVERRIDABLE) {
        assert.equal(wakeViewVerdict(input(over), false).proceed, false, `${name} stops an automatic wake`);
        assert.equal(wakeViewVerdict(input({ manualWake: true, ...over }), false).proceed, true, `${name} does not stop a manual one`);
    }
    assert.equal(wakeViewVerdict(input({ manualWake: true, idleSinceMs: null }), false).proceed, false, "claude busy");
});

test("a panic wake passes the busy reasons and nothing else", () => {
    const busy = wakeViewVerdict(input({ busyDeferUntilMs: T0 + 5 * SEC }), true);
    assert.equal(busy.proceed, true);
    assert.equal(busy.panicBypass, true);
    for (const [name, over] of [...BLOCK_EVERY_WAKE, ["presence hold", { afkMode: "wait_inf" }] as [string, Partial<LoopStateInput>]]) {
        const v = wakeViewVerdict(input(over), true);
        assert.equal(v.proceed, false, name);
        assert.equal(v.panicBypass, false, name);
    }
});

test("the kernel asks for the verdict on every wake, a manual one included", () => {
    const src = readFileSync(join(import.meta.dirname, "kernel.ts"), "utf8");
    const start = src.indexOf("async function tryWakeInner(");
    const call = src.indexOf("wakeViewVerdict(readLoopStateInput(sd!, { manualWake }), panicMode)", start);
    assert.ok(start > 0 && call > start, "tryWakeInner asks wakeViewVerdict, passing the manual flag");
    assert.equal(/if\s*\(\s*!manualWake\s*\)/.test(src.slice(start, call)), false, "and not behind a manual-wake bypass");
});

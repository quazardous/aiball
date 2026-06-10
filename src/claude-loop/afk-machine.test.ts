// AfkMachine tests. Run: `npx tsx --test src/claude-loop/afk-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createActor } from "xstate";
import { afkMachine } from "./afk-machine.js";

// Use a short debounce in tests so the `after` timers fire quickly.
const DEBOUNCE_MS = 30;
const DEBOUNCE_WAIT_MS = 80; // 30ms + slack for the event loop

function mkActor(opts: { debounceMs?: number } = {}) {
    return createActor(afkMachine, {
        input: { debounceMs: opts.debounceMs ?? DEBOUNCE_MS },
    });
}

test("init : starts in off with empty context", () => {
    const actor = mkActor().start();
    assert.equal(actor.getSnapshot().value, "off");
    const ctx = actor.getSnapshot().context;
    assert.equal(ctx.afkMode, "off");
    assert.equal(ctx.afkExpiryMs, null);
    assert.equal(ctx.dispExpiryMs, null);
});

test("ARM_10M from off : transition → pending_10m + dispExpiryMs set", () => {
    const actor = mkActor().start();
    actor.send({ type: "ARM_10M", expiryMsHint: 1_000_000_000 });
    assert.equal(actor.getSnapshot().value, "pending_10m");
    assert.equal(actor.getSnapshot().context.dispExpiryMs, 1_000_000_000);
    assert.equal(actor.getSnapshot().context.afkMode, "off"); // not committed yet
});

test("pending_10m + after(debounce) : commit to wait_10m (fresh)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "ARM_10M", expiryMsHint: 1_000_000_000 });
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(actor.getSnapshot().value, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkMode, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, 1_000_000_000);
});

test("wait_10m + ARM_INF + after(debounce) : commit to wait_inf", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    assert.equal(actor.getSnapshot().value, "wait_10m");
    actor.send({ type: "ARM_INF" });
    assert.equal(actor.getSnapshot().value, "pending_inf");
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(actor.getSnapshot().value, "wait_inf");
    assert.equal(actor.getSnapshot().context.afkMode, "wait_inf");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, null);
});

test("NOOP same-kind : wait_10m cycle wait_10m → INF → OFF → 10m commits without re-arming", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 9_999_999_999 });
    const committedExpiry = actor.getSnapshot().context.afkExpiryMs;
    assert.equal(committedExpiry, 9_999_999_999);

    // Cycle WITHIN debounce window
    actor.send({ type: "ARM_INF" });
    assert.equal(actor.getSnapshot().value, "pending_inf");
    actor.send({ type: "ARM_OFF" });
    assert.equal(actor.getSnapshot().value, "pending_off");
    // toggleAfk wrapper mirrors committed expiry when cycle returns to wait_10m
    actor.send({ type: "ARM_10M", expiryMsHint: 9_999_999_999 });
    assert.equal(actor.getSnapshot().value, "pending_10m");

    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(actor.getSnapshot().value, "wait_10m");
    // afkExpiryMs UNCHANGED — original running timer preserved
    assert.equal(actor.getSnapshot().context.afkExpiryMs, committedExpiry);
});

test("ARM_10M while pending_10m : resets debounce timer (reenter)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "ARM_10M", expiryMsHint: 1_000_000_000 });
    // Wait less than debounce
    await delay(DEBOUNCE_MS - 10);
    // Re-arm — should reset
    actor.send({ type: "ARM_10M", expiryMsHint: 2_000_000_000 });
    assert.equal(actor.getSnapshot().value, "pending_10m");
    assert.equal(actor.getSnapshot().context.dispExpiryMs, 2_000_000_000);
    // Wait a bit more — should NOT have committed yet (timer was reset)
    await delay(DEBOUNCE_MS - 10);
    assert.equal(actor.getSnapshot().value, "pending_10m");
    // Now wait the rest
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(actor.getSnapshot().value, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, 2_000_000_000);
});

test("EXPIRY_REACHED in wait_10m : transition → off", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    assert.equal(actor.getSnapshot().value, "wait_10m");
    actor.send({ type: "EXPIRY_REACHED" });
    assert.equal(actor.getSnapshot().value, "off");
    assert.equal(actor.getSnapshot().context.afkMode, "off");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, null);
});

test("HARD_ARM_10M from off : direct wait_10m (bypass debounce)", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    assert.equal(actor.getSnapshot().value, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkMode, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, 1_000_000_000);
});

test("HARD_ARM_INF from off : direct wait_inf", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_INF" });
    assert.equal(actor.getSnapshot().value, "wait_inf");
    assert.equal(actor.getSnapshot().context.afkMode, "wait_inf");
});

test("HARD_CLEAR from wait_inf : direct off", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_INF" });
    actor.send({ type: "HARD_CLEAR" });
    assert.equal(actor.getSnapshot().value, "off");
    assert.equal(actor.getSnapshot().context.afkMode, "off");
});

test("HARD_ARM_10M from wait_10m : re-arm with new expiry", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    actor.send({ type: "HARD_ARM_10M", expiryMs: 2_000_000_000 });
    assert.equal(actor.getSnapshot().value, "wait_10m");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, 2_000_000_000);
});

test("ARM_OFF cycle from wait_10m → pending_off → off (committed)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    actor.send({ type: "ARM_OFF" });
    assert.equal(actor.getSnapshot().value, "pending_off");
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(actor.getSnapshot().value, "off");
    assert.equal(actor.getSnapshot().context.afkMode, "off");
    assert.equal(actor.getSnapshot().context.afkExpiryMs, null);
});

test("ARM_INF while pending_10m : drops to pending_inf", () => {
    const actor = mkActor().start();
    actor.send({ type: "ARM_10M", expiryMsHint: 1_000_000_000 });
    actor.send({ type: "ARM_INF" });
    assert.equal(actor.getSnapshot().value, "pending_inf");
    assert.equal(actor.getSnapshot().context.dispExpiryMs, null);
});

test("snapshot observable : subscribe fires on transitions", () => {
    const actor = mkActor().start();
    const states: string[] = [];
    actor.subscribe((snap) => states.push(String(snap.value)));
    actor.send({ type: "HARD_ARM_INF" });
    assert.ok(states.includes("wait_inf"));
});

// #877 Slice A — emit / actor.on locus events.

test("emit afk:armed_10m on fresh commit (pending_10m → wait_10m fresh)", async () => {
    const actor = mkActor().start();
    const events: { type: string; expiryMs: number; prevMode: string }[] = [];
    actor.on("afk:armed_10m", (ev) => events.push(ev));
    actor.send({ type: "ARM_10M", expiryMsHint: 1_000_000_000 });
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(events.length, 1);
    assert.equal(events[0].expiryMs, 1_000_000_000);
    assert.equal(events[0].prevMode, "off");
});

test("emit afk:armed_10m on NOOP same-kind commit (prev=wait_10m preserved)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 5_000_000_000 });
    const events: { expiryMs: number; prevMode: string }[] = [];
    actor.on("afk:armed_10m", (ev) => events.push(ev));
    // Cycle returns to wait_10m
    actor.send({ type: "ARM_INF" });
    actor.send({ type: "ARM_10M", expiryMsHint: 5_000_000_000 });
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(events.length, 1);
    assert.equal(events[0].expiryMs, 5_000_000_000);
    assert.equal(events[0].prevMode, "wait_10m");
});

test("emit afk:armed_inf on pending_inf commit", async () => {
    const actor = mkActor().start();
    const events: { prevMode: string }[] = [];
    actor.on("afk:armed_inf", (ev) => events.push(ev));
    actor.send({ type: "ARM_INF" });
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(events.length, 1);
    assert.equal(events[0].prevMode, "off");
});

test("emit afk:cleared (reason=user) on pending_off commit", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_INF" });
    const events: { prevMode: string; reason: string }[] = [];
    actor.on("afk:cleared", (ev) => events.push(ev));
    actor.send({ type: "ARM_OFF" });
    await delay(DEBOUNCE_WAIT_MS);
    assert.equal(events.length, 1);
    assert.equal(events[0].prevMode, "wait_inf");
    assert.equal(events[0].reason, "user");
});

test("emit afk:cleared (reason=expiry) on EXPIRY_REACHED", () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 1_000_000_000 });
    const events: { prevMode: string; reason: string }[] = [];
    actor.on("afk:cleared", (ev) => events.push(ev));
    actor.send({ type: "EXPIRY_REACHED" });
    assert.equal(events.length, 1);
    assert.equal(events[0].prevMode, "wait_10m");
    assert.equal(events[0].reason, "expiry");
});

test("emit afk:armed_10m on HARD_ARM_10M from off (immediate path)", () => {
    const actor = mkActor().start();
    const events: { expiryMs: number; prevMode: string }[] = [];
    actor.on("afk:armed_10m", (ev) => events.push(ev));
    actor.send({ type: "HARD_ARM_10M", expiryMs: 2_000_000_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].expiryMs, 2_000_000_000);
    assert.equal(events[0].prevMode, "off");
});

test("preserveWait10mExpiry mirrors disp to afkExpiryMs after NOOP", async () => {
    const actor = mkActor().start();
    actor.send({ type: "HARD_ARM_10M", expiryMs: 5_000_000_000 });
    // Cycle quickly
    actor.send({ type: "ARM_INF" });
    actor.send({ type: "ARM_10M", expiryMsHint: 5_000_000_000 });
    await delay(DEBOUNCE_WAIT_MS);
    // Both displays should converge on the original committed expiry
    assert.equal(actor.getSnapshot().context.afkExpiryMs, 5_000_000_000);
    assert.equal(actor.getSnapshot().context.dispExpiryMs, 5_000_000_000);
});

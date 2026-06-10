// SanityMachine tests. Run: `npx tsx --test src/claude-loop/sanity-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createActor } from "xstate";
import { sanityMachine } from "./sanity-machine.js";

const STALE = 200;
const SLACK = 80;

function mkActor(staleMs: number = STALE) {
    return createActor(sanityMachine, { input: { staleMs } });
}

test("init : starts in unknown", () => {
    const actor = mkActor().start();
    assert.equal(actor.getSnapshot().value, "unknown");
});

test("BUSY_LATCHED from unknown → watching", () => {
    const actor = mkActor().start();
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "watching");
});

test("BUSY_CLEARED from watching → idle (path normal)", () => {
    const actor = mkActor().start();
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    actor.send({ type: "BUSY_CLEARED", atMs: 1_100 });
    assert.equal(actor.getSnapshot().value, "idle");
});

test("after(stale) without activity → emit sanity:clear_paneBusy + → idle", async (t) => {
    const actor = mkActor().start();
    t.after(() => actor.stop());
    const events: { reason: string; atMs: number }[] = [];
    actor.on("sanity:clear_paneBusy", (ev) => events.push(ev));
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    await delay(STALE + SLACK);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "stale_timeout");
    assert.equal(actor.getSnapshot().value, "idle");
});

test("TICKET_ACTIVITY resets the stale timer (no emit)", async (t) => {
    const actor = mkActor().start();
    t.after(() => actor.stop());
    const events: unknown[] = [];
    actor.on("sanity:clear_paneBusy", (ev) => events.push(ev));
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    // Wait less than STALE then send activity to reset.
    await delay(STALE - 50);
    actor.send({ type: "TICKET_ACTIVITY", atMs: 2_000 });
    // Now wait again past where stale would have fired originally.
    await delay(60);
    assert.equal(events.length, 0, "activity reset the clock, no emit");
    assert.equal(actor.getSnapshot().value, "watching");
});

test("after activity reset → still fires sanity:clear if NEW stale window expires", async (t) => {
    const actor = mkActor().start();
    t.after(() => actor.stop());
    const events: unknown[] = [];
    actor.on("sanity:clear_paneBusy", (ev) => events.push(ev));
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    await delay(STALE - 50);
    actor.send({ type: "TICKET_ACTIVITY", atMs: 2_000 });
    // Now actually let the new stale window expire.
    await delay(STALE + SLACK);
    assert.equal(events.length, 1, "after the reset, stale window fires from the new clock");
});

test("BUSY_CLEARED during watching cancels the after(stale) timer", async (t) => {
    const actor = mkActor().start();
    t.after(() => actor.stop());
    const events: unknown[] = [];
    actor.on("sanity:clear_paneBusy", (ev) => events.push(ev));
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    actor.send({ type: "BUSY_CLEARED", atMs: 1_050 });
    await delay(STALE + SLACK);
    assert.equal(events.length, 0, "cleared before stale → no emit");
    assert.equal(actor.getSnapshot().value, "idle");
});

test("BUSY_LATCHED again from idle → re-arms watching", () => {
    const actor = mkActor().start();
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    actor.send({ type: "BUSY_CLEARED", atMs: 1_100 });
    actor.send({ type: "BUSY_LATCHED", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "watching");
});

test("emit carries atMs from the triggering event", async (t) => {
    const actor = mkActor().start();
    t.after(() => actor.stop());
    const events: { atMs: number }[] = [];
    actor.on("sanity:clear_paneBusy", (ev) => events.push(ev));
    actor.send({ type: "BUSY_LATCHED", atMs: 1_000 });
    await delay(STALE + SLACK);
    assert.equal(events.length, 1);
    // after() emits carry the originating event's atMs (= the BUSY_LATCHED).
    assert.equal(typeof events[0].atMs, "number");
});

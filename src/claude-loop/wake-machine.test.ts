// WakeMachine tests. Run: `npx tsx --test src/claude-loop/wake-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createActor } from "xstate";
import { wakeMachine } from "./wake-machine.js";

// Use short delays in tests so the `after` timers fire quickly.
// COALESCE > IN_FLIGHT_TTL so the inFlight→cooldown safety-net test can
// observe `cooldown` before cooldown auto-returns to idle.
const IN_FLIGHT_TTL_MS = 30;
const COALESCE_MS = 200;
const SLACK = 50;

function mkActor() {
    return createActor(wakeMachine, {
        input: { inFlightTtlMs: IN_FLIGHT_TTL_MS, coalesceWindowMs: COALESCE_MS },
    });
}

/** #848 — la SM démarre en `gated`. Pour les tests pré-existants qui
 *  attendent `idle` initial, on envoie BOOT_READY après start. */
function mkActorReady() {
    const a = mkActor().start();
    a.send({ type: "BOOT_READY" });
    return a;
}

test("init : starts in gated (boot not yet ready)", () => {
    const actor = mkActor().start();
    assert.equal(actor.getSnapshot().value, "gated");
    assert.equal(actor.getSnapshot().context.wakeInFlightAtMs, null);
    assert.equal(actor.getSnapshot().context.lastWakeAtMs, null);
});

test("#848 BOOT_READY : gated → idle", () => {
    const actor = mkActor().start();
    actor.send({ type: "BOOT_READY" });
    assert.equal(actor.getSnapshot().value, "idle");
});

test("#848 REQUEST_WAKE pendant gated : emit cleared(boot_gated), stay gated", () => {
    const actor = mkActor().start();
    const events: { reason: string }[] = [];
    actor.on("wake:cleared", (ev) => events.push(ev));
    actor.send({ type: "REQUEST_WAKE", source: "test", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "gated");
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "boot_gated");
});

test("REQUEST_WAKE from idle : transition → inFlight + stamp wakeInFlightAtMs", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "inFlight");
    assert.equal(actor.getSnapshot().context.wakeInFlightAtMs, 1_000);
});

test("WAKE_DELIVERED in inFlight : emits wake:delivered + stamps lastWakeAtMs, stays inFlight", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    const events: { phrase: string; headMessageId: number | null }[] = [];
    actor.on("wake:delivered", (ev) => events.push(ev));
    actor.send({ type: "WAKE_DELIVERED", phrase: "Hello", headMessageId: 42, deliveredAtMs: 1_500 });
    assert.equal(actor.getSnapshot().value, "inFlight");
    assert.equal(actor.getSnapshot().context.lastWakeAtMs, 1_500);
    assert.equal(events.length, 1);
    assert.equal(events[0].phrase, "Hello");
    assert.equal(events[0].headMessageId, 42);
});

test("WAKE_COMPLETED in inFlight : transition → cooldown + clear wakeInFlightAtMs", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    actor.send({ type: "WAKE_COMPLETED" });
    assert.equal(actor.getSnapshot().value, "cooldown");
    assert.equal(actor.getSnapshot().context.wakeInFlightAtMs, null);
});

test("REQUEST_WAKE during cooldown : ignored (state stays cooldown)", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    actor.send({ type: "WAKE_COMPLETED" });
    assert.equal(actor.getSnapshot().value, "cooldown");
    actor.send({ type: "REQUEST_WAKE", source: "ping2", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "cooldown");
});

test("after(coalesceWindow) : cooldown → idle", async () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    actor.send({ type: "WAKE_COMPLETED" });
    await delay(COALESCE_MS + SLACK);
    assert.equal(actor.getSnapshot().value, "idle");
});

test("after(inFlightTtl) : inFlight → cooldown (safety net)", async () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "inFlight");
    await delay(IN_FLIGHT_TTL_MS + SLACK);
    assert.equal(actor.getSnapshot().value, "cooldown");
});

test("REQUEST_WAKE during inFlight : ignored (mutex)", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    actor.send({ type: "REQUEST_WAKE", source: "ping2", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "inFlight");
    assert.equal(actor.getSnapshot().context.wakeInFlightAtMs, 1_000); // unchanged
});

// #877 emit / actor.on locus events.

test("emit wake:requested on REQUEST_WAKE", () => {
    const actor = mkActorReady();
    const events: { source: string; atMs: number }[] = [];
    actor.on("wake:requested", (ev) => events.push(ev));
    actor.send({ type: "REQUEST_WAKE", source: "heartbeat", atMs: 1_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "heartbeat");
    assert.equal(events[0].atMs, 1_000);
});

test("emit wake:in_flight_started on REQUEST_WAKE", () => {
    const actor = mkActorReady();
    const events: { atMs: number }[] = [];
    actor.on("wake:in_flight_started", (ev) => events.push(ev));
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_000);
});

test("emit wake:cleared (reason=completed) on WAKE_COMPLETED", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    const events: { reason: string }[] = [];
    actor.on("wake:cleared", (ev) => events.push(ev));
    actor.send({ type: "WAKE_COMPLETED" });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "completed");
});

test("emit wake:cleared (reason=ttl) on IN_FLIGHT_TTL_EXPIRED", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    const events: { reason: string }[] = [];
    actor.on("wake:cleared", (ev) => events.push(ev));
    actor.send({ type: "IN_FLIGHT_TTL_EXPIRED" });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "ttl");
});

test("WAKE_SKIPPED in inFlight : transition → idle directement (pas de cooldown)", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "inFlight");
    actor.send({ type: "WAKE_SKIPPED" });
    assert.equal(actor.getSnapshot().value, "idle", "skip retourne directement à idle (no cooldown)");
    assert.equal(actor.getSnapshot().context.wakeInFlightAtMs, null);
});

test("emit wake:cleared (reason=skipped) on WAKE_SKIPPED", () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    const events: { reason: string }[] = [];
    actor.on("wake:cleared", (ev) => events.push(ev));
    actor.send({ type: "WAKE_SKIPPED" });
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "skipped");
});

test("emit wake:cooldown_expired on cooldown → idle", async () => {
    const actor = mkActorReady();
    actor.send({ type: "REQUEST_WAKE", source: "ping", atMs: 1_000 });
    actor.send({ type: "WAKE_COMPLETED" });
    const events: unknown[] = [];
    actor.on("wake:cooldown_expired", (ev) => events.push(ev));
    await delay(COALESCE_MS + SLACK);
    assert.equal(events.length, 1);
});

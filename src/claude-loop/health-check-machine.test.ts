// HealthCheckMachine tests. Run: `npx tsx --test src/claude-loop/health-check-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { healthCheckMachine } from "./health-check-machine.js";

test("init : starts in idle", () => {
    const actor = createActor(healthCheckMachine).start();
    assert.equal(actor.getSnapshot().value, "idle");
});

test("PROMPT_DETECTED from idle → prompted + emits health:prompt_detected", () => {
    const actor = createActor(healthCheckMachine).start();
    const events: { type: string; atMs: number }[] = [];
    actor.on("health:prompt_detected", (ev) => events.push(ev));
    actor.send({ type: "PROMPT_DETECTED", atMs: 1_700 });
    assert.equal(actor.getSnapshot().value, "prompted");
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_700);
});

test("PROMPT_CLEARED from prompted → idle + emits health:prompt_cleared", () => {
    const actor = createActor(healthCheckMachine).start();
    const events: { type: string; atMs: number }[] = [];
    actor.on("health:prompt_cleared", (ev) => events.push(ev));
    actor.send({ type: "PROMPT_DETECTED", atMs: 1_700 });
    actor.send({ type: "PROMPT_CLEARED", atMs: 1_900 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(events.length, 1);
    assert.equal(events[0].atMs, 1_900);
});

test("redundant PROMPT_DETECTED while prompted → no double emit", () => {
    const actor = createActor(healthCheckMachine).start();
    const events: unknown[] = [];
    actor.on("health:prompt_detected", (ev) => events.push(ev));
    actor.send({ type: "PROMPT_DETECTED", atMs: 1 });
    actor.send({ type: "PROMPT_DETECTED", atMs: 2 });
    assert.equal(events.length, 1);
    assert.equal(actor.getSnapshot().value, "prompted");
});

test("PROMPT_CLEARED while idle → stays idle, no emit", () => {
    const actor = createActor(healthCheckMachine).start();
    const events: unknown[] = [];
    actor.on("health:prompt_cleared", (ev) => events.push(ev));
    actor.send({ type: "PROMPT_CLEARED", atMs: 1 });
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(events.length, 0);
});

test("round-trip : detected → cleared → detected again fires both events twice", () => {
    const actor = createActor(healthCheckMachine).start();
    const detected: unknown[] = [];
    const cleared: unknown[] = [];
    actor.on("health:prompt_detected", (ev) => detected.push(ev));
    actor.on("health:prompt_cleared", (ev) => cleared.push(ev));
    actor.send({ type: "PROMPT_DETECTED", atMs: 1 });
    actor.send({ type: "PROMPT_CLEARED", atMs: 2 });
    actor.send({ type: "PROMPT_DETECTED", atMs: 3 });
    actor.send({ type: "PROMPT_CLEARED", atMs: 4 });
    assert.equal(detected.length, 2);
    assert.equal(cleared.length, 2);
});

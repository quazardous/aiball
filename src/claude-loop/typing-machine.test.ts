// TypingMachine tests. Run: `npx tsx --test src/claude-loop/typing-machine.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createActor } from "xstate";
import { typingMachine } from "./typing-machine.js";

const TTL_MS = 50;
const SLACK = 30;

function mkActor() {
    return createActor(typingMachine, { input: { ttlMs: TTL_MS } });
}

test("init : starts in idle with null lastKeystrokeMs", () => {
    const actor = mkActor().start();
    assert.equal(actor.getSnapshot().value, "idle");
    assert.equal(actor.getSnapshot().context.lastKeystrokeMs, null);
});

test("KEYSTROKE from idle : transition → hot + stamp", () => {
    const actor = mkActor().start();
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    assert.equal(actor.getSnapshot().value, "hot");
    assert.equal(actor.getSnapshot().context.lastKeystrokeMs, 1_000);
});

test("after(ttl) : hot → idle (auto-exit)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    await delay(TTL_MS + SLACK);
    assert.equal(actor.getSnapshot().value, "idle");
});

test("KEYSTROKE in hot : refresh stamp + reset TTL (reenter)", async () => {
    const actor = mkActor().start();
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    // Wait MOST of the TTL.
    await delay(TTL_MS - 20);
    // Reenter — must reset.
    actor.send({ type: "KEYSTROKE", atMs: 2_000 });
    assert.equal(actor.getSnapshot().value, "hot");
    assert.equal(actor.getSnapshot().context.lastKeystrokeMs, 2_000);
    // Wait the rest of the original TTL window. If reset worked, still hot.
    await delay(20);
    assert.equal(actor.getSnapshot().value, "hot");
    // Now wait the full TTL from the second keystroke.
    await delay(TTL_MS + SLACK);
    assert.equal(actor.getSnapshot().value, "idle");
});

// Emit / actor.on locus events.

test("emit typing:started on idle → hot (single fire per burst)", () => {
    const actor = mkActor().start();
    const events: { atMs: number }[] = [];
    actor.on("typing:started", (ev) => events.push(ev));
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    actor.send({ type: "KEYSTROKE", atMs: 1_010 });
    actor.send({ type: "KEYSTROKE", atMs: 1_020 });
    assert.equal(events.length, 1, "typing:started fires once per burst");
    assert.equal(events[0].atMs, 1_000);
});

test("emit typing:ended on hot → idle (after TTL)", async () => {
    const actor = mkActor().start();
    const events: { lastKeystrokeMs: number }[] = [];
    actor.on("typing:ended", (ev) => events.push(ev));
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    await delay(TTL_MS + SLACK);
    assert.equal(events.length, 1);
    assert.equal(events[0].lastKeystrokeMs, 1_000);
});

test("burst then quiet then new burst : typing:started fires twice", async () => {
    const actor = mkActor().start();
    const events: number[] = [];
    actor.on("typing:started", (ev) => events.push(ev.atMs));
    // Burst 1.
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    actor.send({ type: "KEYSTROKE", atMs: 1_010 });
    await delay(TTL_MS + SLACK);
    assert.equal(actor.getSnapshot().value, "idle");
    // Burst 2.
    actor.send({ type: "KEYSTROKE", atMs: 2_000 });
    assert.equal(events.length, 2);
    assert.deepEqual(events, [1_000, 2_000]);
});

test("snapshot observable : subscribe fires sur transitions", () => {
    const actor = mkActor().start();
    const states: string[] = [];
    actor.subscribe((snap) => states.push(String(snap.value)));
    actor.send({ type: "KEYSTROKE", atMs: 1_000 });
    assert.ok(states.includes("hot"));
});

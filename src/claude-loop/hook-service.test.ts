// #652 Slice 1 — HookService unit tests.
// Run: `npx tsx --test src/claude-loop/hook-service.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    HookService,
    getHookService,
    resetHookServiceForTests,
    type HookEvent,
} from "./hook-service.js";

test("default state: queueing off, queue empty, no listeners", () => {
    const svc = new HookService();
    assert.equal(svc.isBootQueueing(), false);
    assert.equal(svc.queueLength(), 0);
    assert.deepEqual(svc.snapshot(), []);
});

test("emit when not queueing → notifies subscribers immediately", () => {
    const svc = new HookService();
    const seen: HookEvent[] = [];
    svc.subscribe((e) => { seen.push(e); });
    svc.emit({ kind: "SessionStart", source: "resume", at_ms: 1_000 });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { kind: "SessionStart", source: "resume", at_ms: 1_000 });
});

test("emit when queueing → stashes, no notify", () => {
    const svc = new HookService();
    let calls = 0;
    svc.subscribe(() => { calls++; });
    svc.setBootQueueing(true);
    svc.emit({ kind: "SessionStart", source: "startup", at_ms: 100 });
    svc.emit({ kind: "Stop", at_ms: 200 });
    assert.equal(calls, 0, "no notify while queueing");
    assert.equal(svc.queueLength(), 2);
});

test("drainBoot fires queued events in FIFO order", () => {
    const svc = new HookService();
    const seen: HookEvent[] = [];
    svc.subscribe((e) => { seen.push(e); });
    svc.setBootQueueing(true);
    svc.emit({ kind: "SessionStart", source: "resume", at_ms: 1 });
    svc.emit({ kind: "PreToolUse", tool_name: "Bash", at_ms: 2 });
    svc.emit({ kind: "Stop", at_ms: 3 });
    assert.equal(svc.drainBoot(), 3);
    assert.deepEqual(seen.map((e) => e.at_ms), [1, 2, 3]);
    assert.equal(svc.queueLength(), 0);
});

test("drainBoot on empty queue → 0, no fire", () => {
    const svc = new HookService();
    let calls = 0;
    svc.subscribe(() => { calls++; });
    assert.equal(svc.drainBoot(), 0);
    assert.equal(calls, 0);
});

test("drainBoot does NOT flip the queueing flag", () => {
    const svc = new HookService();
    svc.setBootQueueing(true);
    svc.emit({ kind: "Stop", at_ms: 1 });
    svc.drainBoot();
    assert.equal(svc.isBootQueueing(), true, "flag stays on after drain");
    // Subsequent emit still queues.
    svc.emit({ kind: "Stop", at_ms: 2 });
    assert.equal(svc.queueLength(), 1);
});

test("emit after drain + queueing off → notifies immediately", () => {
    const svc = new HookService();
    const seen: HookEvent[] = [];
    svc.subscribe((e) => { seen.push(e); });
    svc.setBootQueueing(true);
    svc.emit({ kind: "Stop", at_ms: 1 });
    svc.drainBoot();
    svc.setBootQueueing(false);
    svc.emit({ kind: "Stop", at_ms: 2 });
    assert.deepEqual(seen.map((e) => e.at_ms), [1, 2]);
});

test("unsubscribe stops future calls", () => {
    const svc = new HookService();
    let calls = 0;
    const off = svc.subscribe(() => { calls++; });
    svc.emit({ kind: "Stop", at_ms: 1 });
    off();
    svc.emit({ kind: "Stop", at_ms: 2 });
    assert.equal(calls, 1);
});

test("multiple subscribers all fire", () => {
    const svc = new HookService();
    let a = 0, b = 0;
    svc.subscribe(() => { a++; });
    svc.subscribe(() => { b++; });
    svc.emit({ kind: "Stop", at_ms: 1 });
    assert.equal(a, 1);
    assert.equal(b, 1);
});

test("throwing subscriber doesn't block the others", () => {
    const svc = new HookService();
    let bCalled = false;
    svc.subscribe(() => { throw new Error("a went boom"); });
    svc.subscribe(() => { bCalled = true; });
    svc.emit({ kind: "Stop", at_ms: 1 });
    assert.equal(bCalled, true, "second subscriber still fires after first throws");
});

test("subscribeBootQueueing fires on flag transitions", () => {
    const svc = new HookService();
    const seen: boolean[] = [];
    svc.subscribeBootQueueing((q) => { seen.push(q); });
    svc.setBootQueueing(true);
    svc.setBootQueueing(false);
    svc.setBootQueueing(true);
    assert.deepEqual(seen, [true, false, true]);
});

test("subscribeBootQueueing skip no-op transitions", () => {
    const svc = new HookService();
    let calls = 0;
    svc.subscribeBootQueueing(() => { calls++; });
    svc.setBootQueueing(false); // already false
    assert.equal(calls, 0);
    svc.setBootQueueing(true);
    svc.setBootQueueing(true); // already true
    assert.equal(calls, 1);
});

test("snapshot returns a defensive copy (mutations don't leak in)", () => {
    const svc = new HookService();
    svc.setBootQueueing(true);
    svc.emit({ kind: "Stop", at_ms: 1 });
    const snap = svc.snapshot();
    snap.pop();
    assert.equal(svc.queueLength(), 1, "mutating snapshot doesn't drain the queue");
});

test("SessionStart variants carry the source field through the queue", () => {
    const svc = new HookService();
    const seen: HookEvent[] = [];
    svc.subscribe((e) => { seen.push(e); });
    svc.setBootQueueing(true);
    svc.emit({ kind: "SessionStart", source: "resume", at_ms: 1 });
    svc.emit({ kind: "SessionStart", source: "compact", at_ms: 2 });
    svc.drainBoot();
    assert.equal(seen.length, 2);
    assert.equal(seen[0].kind, "SessionStart");
    assert.equal((seen[0] as Extract<HookEvent, { kind: "SessionStart" }>).source, "resume");
    assert.equal((seen[1] as Extract<HookEvent, { kind: "SessionStart" }>).source, "compact");
});

test("PreToolUse carries tool_name", () => {
    const svc = new HookService();
    const seen: HookEvent[] = [];
    svc.subscribe((e) => { seen.push(e); });
    svc.emit({ kind: "PreToolUse", tool_name: "Bash", at_ms: 1 });
    svc.emit({ kind: "PreToolUse", tool_name: "Read", at_ms: 2 });
    assert.equal((seen[0] as Extract<HookEvent, { kind: "PreToolUse" }>).tool_name, "Bash");
    assert.equal((seen[1] as Extract<HookEvent, { kind: "PreToolUse" }>).tool_name, "Read");
});

test("getHookService returns the singleton across calls", () => {
    resetHookServiceForTests();
    const a = getHookService();
    const b = getHookService();
    assert.equal(a, b);
});

test("resetHookServiceForTests replaces the singleton with a fresh instance", () => {
    const a = getHookService();
    a.setBootQueueing(true);
    a.emit({ kind: "Stop", at_ms: 1 });
    resetHookServiceForTests();
    const b = getHookService();
    assert.notEqual(a, b);
    assert.equal(b.isBootQueueing(), false);
    assert.equal(b.queueLength(), 0);
});

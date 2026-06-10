// #893 Slice A — HookWatcher unit tests.
// Run: `npx tsx --test src/claude-loop/hook-watcher.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HookWatcher, getHookWatcher, resetHookWatcherForTests } from "./hook-watcher.js";

test("on(hook:stop) receives emit with matching payload", () => {
    const w = new HookWatcher();
    const seen: { atMs: number }[] = [];
    w.on("hook:stop", (ev) => seen.push({ atMs: ev.atMs }));
    w.emit({ type: "hook:stop", atMs: 1234, busyDeferUntilMs: null });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].atMs, 1234);
});

test("on(hook:stop) is not invoked for hook:user_prompt_submit emit", () => {
    const w = new HookWatcher();
    let fired = 0;
    w.on("hook:stop", () => { fired++; });
    w.emit({ type: "hook:user_prompt_submit", fromAutoWake: false, atMs: 1234 });
    assert.equal(fired, 0);
});

test("unsubscribe stops further calls", () => {
    const w = new HookWatcher();
    const seen: number[] = [];
    const sub = w.on("hook:stop", (ev) => seen.push(ev.atMs));
    w.emit({ type: "hook:stop", atMs: 1 });
    sub.unsubscribe();
    w.emit({ type: "hook:stop", atMs: 2 });
    assert.deepEqual(seen, [1]);
});

test("multiple subscribers all fire", () => {
    const w = new HookWatcher();
    const a: number[] = [], b: number[] = [];
    w.on("hook:stop", (ev) => a.push(ev.atMs));
    w.on("hook:stop", (ev) => b.push(ev.atMs));
    w.emit({ type: "hook:stop", atMs: 42 });
    assert.deepEqual(a, [42]);
    assert.deepEqual(b, [42]);
});

test("listener exception does not stop downstream listeners or break emit", () => {
    const w = new HookWatcher();
    const seen: number[] = [];
    w.on("hook:stop", () => { throw new Error("boom"); });
    w.on("hook:stop", (ev) => seen.push(ev.atMs));
    w.emit({ type: "hook:stop", atMs: 1 });
    assert.deepEqual(seen, [1]);
});

test("on(hook:session_start) carries source + picker fields", () => {
    const w = new HookWatcher();
    let captured: { source?: string; pickerSession?: boolean } | null = null;
    w.on("hook:session_start", (ev) => {
        captured = { source: ev.source, pickerSession: ev.pickerSession };
    });
    w.emit({ type: "hook:session_start", source: "startup", atMs: 0, pickerSession: true });
    assert.notEqual(captured, null);
    assert.equal(captured!.source, "startup");
    assert.equal(captured!.pickerSession, true);
});

test("getHookWatcher returns the singleton", () => {
    resetHookWatcherForTests();
    assert.equal(getHookWatcher(), getHookWatcher());
});

test("resetHookWatcherForTests gives a fresh instance", () => {
    const a = getHookWatcher();
    resetHookWatcherForTests();
    const b = getHookWatcher();
    assert.notEqual(a, b);
});

test("listenerCount mirrors subscriber state", () => {
    const w = new HookWatcher();
    assert.equal(w.listenerCount("hook:stop"), 0);
    const sub = w.on("hook:stop", () => {});
    assert.equal(w.listenerCount("hook:stop"), 1);
    sub.unsubscribe();
    assert.equal(w.listenerCount("hook:stop"), 0);
});

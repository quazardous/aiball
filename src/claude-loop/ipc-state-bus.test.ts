/**
 * #856 Phase 1 — pub/sub on the ipcState bus. Each `setIpc*` must call
 * `notifyIpcChanged` so subscribers (timer.ts:schedulePush) react in
 * 50ms. The tests below pin the contract for a handful of setters ;
 * the full set is exercised in the integration paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    _resetIpcSubscribersForTests,
    onIpcChanged,
    resetIpcStateForTests,
    setIpcBootComplete,
    setIpcBusyDeferUntil,
    setIpcHumanTypingAtMs,
    setIpcPaneBusy,
    setIpcResumeSessionPicker,
} from "./ipc-state.js";

function reset() {
    _resetIpcSubscribersForTests();
    resetIpcStateForTests();
}

test("#856 onIpcChanged fires on setIpcBootComplete", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    setIpcBootComplete(true);
    assert.equal(calls, 1, "setIpcBootComplete must notify subscribers");
});

test("#856 onIpcChanged fires on setIpcBusyDeferUntil", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    setIpcBusyDeferUntil(Date.now() + 5000);
    assert.equal(calls, 1);
});

test("#856 onIpcChanged fires on setIpcHumanTypingAtMs", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    setIpcHumanTypingAtMs(Date.now());
    assert.equal(calls, 1);
});

test("#856 onIpcChanged fires on setIpcPaneBusy", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    setIpcPaneBusy(true);
    assert.equal(calls, 1);
});

test("#856 onIpcChanged fires on setIpcResumeSessionPicker", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    setIpcResumeSessionPicker(true);
    assert.equal(calls, 1);
});

test("#856 onIpcChanged returns an unsubscribe fn", () => {
    reset();
    let calls = 0;
    const unsub = onIpcChanged(() => { calls++; });
    setIpcBootComplete(true);
    assert.equal(calls, 1);
    unsub();
    setIpcBootComplete(false);
    assert.equal(calls, 1, "after unsub, no further notifications");
});

test("#856 multiple subscribers each fire", () => {
    reset();
    let a = 0, b = 0, c = 0;
    onIpcChanged(() => { a++; });
    onIpcChanged(() => { b++; });
    onIpcChanged(() => { c++; });
    setIpcBootComplete(true);
    assert.equal(a, 1);
    assert.equal(b, 1);
    assert.equal(c, 1);
});

test("#856 buggy subscriber does not block others", () => {
    reset();
    let good = 0;
    onIpcChanged(() => { throw new Error("boom"); });
    onIpcChanged(() => { good++; });
    setIpcBootComplete(true);
    assert.equal(good, 1, "a throwing subscriber must not poison the chain");
});

test("#856 burst of setIpc calls fire one notify each (debounce is consumer-side)", () => {
    reset();
    let calls = 0;
    onIpcChanged(() => { calls++; });
    // 3 distinct setters in a row → 3 notifications. Coalescing into a
    // single push is the consumer's job (schedulePush 50ms debounce in
    // timer.ts) — at the bus layer every mutation broadcasts.
    setIpcBootComplete(true);
    setIpcBusyDeferUntil(Date.now() + 1000);
    setIpcHumanTypingAtMs(Date.now());
    assert.equal(calls, 3);
});

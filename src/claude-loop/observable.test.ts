// #649 Slice 1 — Observable<T> unit tests (extracted from
// pane-service.test.ts which exercised the same machinery per-marker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Observable } from "./observable.js";

test("get returns the initial value", () => {
    const o = new Observable<number>(42);
    assert.equal(o.get(), 42);
});

test("set updates value and is reflected by get", () => {
    const o = new Observable<string>("a");
    o.set("b");
    assert.equal(o.get(), "b");
});

test("set is idempotent — same value is a no-op", () => {
    const o = new Observable<number>(1);
    let calls = 0;
    o.subscribe(() => { calls++; });
    o.set(1);   // no transition
    o.set(2);   // transition
    o.set(2);   // no transition
    o.set(3);   // transition
    assert.equal(calls, 2);
});

test("Object.is equality — NaN is treated as equal to itself", () => {
    const o = new Observable<number>(NaN);
    let calls = 0;
    o.subscribe(() => { calls++; });
    o.set(NaN);
    assert.equal(calls, 0, "NaN === NaN should be silent");
});

test("subscribe NOT called with initial value at subscribe time", () => {
    const o = new Observable<boolean>(true);
    let calls = 0;
    o.subscribe(() => { calls++; });
    assert.equal(calls, 0, "must wait for an actual transition");
});

test("subscribe receives the new value on each transition", () => {
    const o = new Observable<string>("x");
    const seen: string[] = [];
    o.subscribe((v) => { seen.push(v); });
    o.set("y");
    o.set("z");
    assert.deepEqual(seen, ["y", "z"]);
});

test("unsubscribe stops further calls", () => {
    const o = new Observable<number>(0);
    let calls = 0;
    const off = o.subscribe(() => { calls++; });
    o.set(1);
    off();
    o.set(2);
    assert.equal(calls, 1);
});

test("multiple subscribers all fire", () => {
    const o = new Observable<number>(0);
    let a = 0, b = 0;
    o.subscribe(() => { a++; });
    o.subscribe(() => { b++; });
    o.set(1);
    assert.equal(a, 1);
    assert.equal(b, 1);
});

test("listener that throws does NOT break siblings", () => {
    const o = new Observable<number>(0);
    let okCalls = 0;
    o.subscribe(() => { throw new Error("boom"); });
    o.subscribe(() => { okCalls++; });
    o.set(1);
    assert.equal(okCalls, 1);
});

test("listener that unsubscribes itself during callback doesn't trip iteration", () => {
    const o = new Observable<number>(0);
    let calls = 0;
    const off: (() => void) | undefined = o.subscribe(() => { calls++; off?.(); });
    o.set(1);
    o.set(2);
    assert.equal(calls, 1, "second transition shouldn't call (unsubbed)");
});

test("listener that ADDS a new subscriber during callback doesn't trip iteration", () => {
    const o = new Observable<number>(0);
    const log: string[] = [];
    o.subscribe((v) => {
        log.push(`a:${v}`);
        o.subscribe((vv) => { log.push(`b:${vv}`); });
    });
    o.set(1); // a:1 fires, b is added but not called for this transition
    o.set(2); // a:2 + b:2 fire
    assert.deepEqual(log, ["a:1", "a:2", "b:2"]);
});

test("listenerCount reflects current registration", () => {
    const o = new Observable<boolean>(false);
    assert.equal(o.listenerCount(), 0);
    const off1 = o.subscribe(() => {});
    assert.equal(o.listenerCount(), 1);
    const off2 = o.subscribe(() => {});
    assert.equal(o.listenerCount(), 2);
    off1();
    assert.equal(o.listenerCount(), 1);
    off2();
    assert.equal(o.listenerCount(), 0);
});

test("works with object values", () => {
    interface Foo { x: number }
    const initial: Foo = { x: 1 };
    const o = new Observable<Foo>(initial);
    assert.deepEqual(o.get(), { x: 1 });
    let calls = 0;
    o.subscribe(() => { calls++; });
    o.set(initial);   // same reference → no-op
    assert.equal(calls, 0);
    o.set({ x: 1 });  // different reference (Object.is) → fires
    assert.equal(calls, 1);
});

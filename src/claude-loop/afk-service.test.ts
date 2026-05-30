// #649 Slice 2 — AfkService unit tests. Greenfield, no fs/process side
// effects (service is pure data over Observable<AfkState> + expiryMs
// field). Run: `npx tsx --test src/claude-loop/afk-service.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AfkService, getAfkService, resetAfkServiceForTests } from "./afk-service.js";

test("default state is 'off' with no expiry", () => {
    const s = new AfkService();
    assert.equal(s.getState(), "off");
    assert.equal(s.expiryMs(), null);
});

test("constructor with explicit initial state", () => {
    const s = new AfkService("wait_inf");
    assert.equal(s.getState(), "wait_inf");
    assert.equal(s.expiryMs(), null);
});

test("constructor with wait_10m + expiryMs", () => {
    const t = 1_000_000_000_000;
    const s = new AfkService("wait_10m", t);
    assert.equal(s.getState(), "wait_10m");
    assert.equal(s.expiryMs(), t);
});

test("constructor ignores expiryMs when initial state is not wait_10m", () => {
    const s = new AfkService("off", 1234567);
    assert.equal(s.expiryMs(), null, "expiry only meaningful for wait_10m");
});

test("setOff clears state + expiry", () => {
    const s = new AfkService("wait_10m", Date.now() + 60_000);
    s.setOff();
    assert.equal(s.getState(), "off");
    assert.equal(s.expiryMs(), null);
});

test("set10m sets state + stores expiry", () => {
    const s = new AfkService();
    const exp = Date.now() + 600_000;
    s.set10m(exp);
    assert.equal(s.getState(), "wait_10m");
    assert.equal(s.expiryMs(), exp);
});

test("setInf sets state + clears expiry", () => {
    const s = new AfkService("wait_10m", Date.now() + 60_000);
    s.setInf();
    assert.equal(s.getState(), "wait_inf");
    assert.equal(s.expiryMs(), null);
});

test("subscribe fires on every state transition", () => {
    const s = new AfkService();
    const seen: string[] = [];
    s.subscribe((state) => { seen.push(state); });
    s.set10m(Date.now() + 60_000);
    s.setInf();
    s.setOff();
    assert.deepEqual(seen, ["wait_10m", "wait_inf", "off"]);
});

test("subscribe does NOT fire on no-op set (same state)", () => {
    const s = new AfkService("off");
    let calls = 0;
    s.subscribe(() => { calls++; });
    s.setOff();  // already off
    assert.equal(calls, 0);
});

test("set10m → set10m with NEW expiry doesn't fire transition (state unchanged)", () => {
    const s = new AfkService();
    const exp1 = Date.now() + 600_000;
    const exp2 = exp1 + 60_000;
    s.set10m(exp1);
    let calls = 0;
    s.subscribe(() => { calls++; });
    s.set10m(exp2);  // state still wait_10m → no transition fire
    assert.equal(calls, 0, "Observable<AfkState> idempotent on equal state");
    assert.equal(s.expiryMs(), exp2, "but expiry was updated");
});

test("unsubscribe stops further calls", () => {
    const s = new AfkService();
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    s.setInf();
    off();
    s.setOff();
    assert.equal(calls, 1);
});

test("snapshot() returns both state + expiry", () => {
    const s = new AfkService();
    const exp = Date.now() + 600_000;
    s.set10m(exp);
    const snap = s.snapshot();
    assert.equal(snap.state, "wait_10m");
    assert.equal(snap.expiryMs, exp);
});

test("remainingMs returns positive ms while countdown runs", () => {
    const s = new AfkService();
    const exp = 1_000_000;
    s.set10m(exp);
    assert.equal(s.remainingMs(900_000), 100_000);
});

test("remainingMs returns 0 at/after expiry (clamped, not negative)", () => {
    const s = new AfkService();
    s.set10m(1_000_000);
    assert.equal(s.remainingMs(1_000_000), 0);
    assert.equal(s.remainingMs(1_200_000), 0);
});

test("remainingMs returns null when state is off", () => {
    const s = new AfkService();
    assert.equal(s.remainingMs(), null);
});

test("remainingMs returns null when state is wait_inf", () => {
    const s = new AfkService();
    s.setInf();
    assert.equal(s.remainingMs(), null);
});

test("getAfkService returns the same singleton instance", () => {
    resetAfkServiceForTests();
    const a = getAfkService();
    const b = getAfkService();
    assert.equal(a, b);
});

test("resetAfkServiceForTests replaces the singleton", () => {
    const a = getAfkService();
    a.setInf();
    resetAfkServiceForTests();
    const b = getAfkService();
    assert.notEqual(a, b);
    assert.equal(b.getState(), "off", "fresh service starts at off");
});

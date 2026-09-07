// #2074 — the enrolment switch.
//
// What matters here is that it is SHUT: shut by default, shut again on its own,
// and shut after a restart. The open case is the easy one.
import test from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_PAIRING_WINDOW_MS,
    MAX_PAIRING_WINDOW_MS,
    __resetPairingWindow,
    closePairingWindow,
    openPairingWindow,
    pairingWindow,
} from "./node-pairing-window.js";

const T = 1_700_000_000_000;

test("shut by default — a fresh process pairs with nobody", () => {
    __resetPairingWindow();
    const w = pairingWindow(T);
    assert.equal(w.open, false);
    assert.equal(w.open_until, null);
    assert.equal(w.seconds_left, 0);
    assert.equal(w.opened_by, null);
});

test("a human opens it, and it says who and for how long", () => {
    __resetPairingWindow();
    const w = openPairingWindow("david", DEFAULT_PAIRING_WINDOW_MS, T);
    assert.equal(w.open, true);
    assert.equal(w.opened_by, "david");
    assert.equal(w.seconds_left, DEFAULT_PAIRING_WINDOW_MS / 1000);
});

test("it shuts on its own — that is the whole point of a window", () => {
    __resetPairingWindow();
    openPairingWindow("david", 60_000, T);
    assert.equal(pairingWindow(T + 59_999).open, true);
    assert.equal(pairingWindow(T + 60_000).open, false, "shut at the boundary, not after it");
    assert.equal(pairingWindow(T + 60_001).seconds_left, 0);
});

test("closing is immediate — the panic button works", () => {
    __resetPairingWindow();
    openPairingWindow("david", DEFAULT_PAIRING_WINDOW_MS, T);
    const w = closePairingWindow(T + 1000);
    assert.equal(w.open, false);
    assert.equal(pairingWindow(T + 2000).open, false);
});

test("re-opening replaces the window instead of extending it", () => {
    // So "how long is it open" always answers with the last thing a human
    // chose, rather than a sum nobody tracked.
    __resetPairingWindow();
    openPairingWindow("david", 10 * 60_000, T);
    const w = openPairingWindow("david", 60_000, T + 1000);
    assert.equal(w.seconds_left, 60);
});

test("a long window is clamped — 'open it for a day' is not one typo away", () => {
    __resetPairingWindow();
    const w = openPairingWindow("david", 24 * 60 * 60_000, T);
    assert.equal(w.seconds_left, MAX_PAIRING_WINDOW_MS / 1000);
});

test("a zero or negative span still shuts on its own rather than never", () => {
    __resetPairingWindow();
    const w = openPairingWindow("david", 0, T);
    assert.equal(w.open, true, "a floor keeps it coherent…");
    assert.equal(pairingWindow(T + 2000).open, false, "…and it is gone a second later");
});

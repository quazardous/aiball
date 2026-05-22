// #351 — afk_key parser + AFK detector. node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAfkKey, AfkDetector } from "./afk-key.js";

// ---- parseAfkKey (pure: notation → byte combos) ----------------------

test("parseAfkKey: single combos → byte sequences", () => {
    assert.deepEqual(parseAfkKey("esc", 400).combos, [[0x1b]]);
    assert.deepEqual(parseAfkKey("ctrl+a", 400).combos, [[0x01]]);
    assert.deepEqual(parseAfkKey("ctrl+]", 400).combos, [[0x1d]]);
    assert.deepEqual(parseAfkKey("a", 400).combos, [[0x61]]);
    assert.deepEqual(parseAfkKey("alt+x", 400).combos, [[0x1b, 0x78]]);
    assert.deepEqual(parseAfkKey("f9", 400).combos, [[0x1b, 0x5b, 0x32, 0x30, 0x7e]]);
});

test("parseAfkKey: 2-combo sequence + window carried through", () => {
    const spec = parseAfkKey("esc esc", 400);
    assert.deepEqual(spec.combos, [[0x1b], [0x1b]]);
    assert.equal(spec.windowMs, 400);

    assert.deepEqual(parseAfkKey("ctrl+a d", 250).combos, [[0x01], [0x64]]);
});

test("parseAfkKey: rejects empty / >2 combos / bad ctrl / unknown key", () => {
    assert.throws(() => parseAfkKey("", 400));
    assert.throws(() => parseAfkKey("   ", 400));
    assert.throws(() => parseAfkKey("esc esc esc", 400)); // 3 combos
    assert.throws(() => parseAfkKey("ctrl+esc", 400)); // ctrl needs single char
    assert.throws(() => parseAfkKey("f99", 400)); // unknown named key
});

// ---- AfkDetector (stateful, clock injected) --------------------------

test("detector: single combo fires on exact match, ignores others", () => {
    const d = new AfkDetector(parseAfkKey("esc", 400));
    assert.equal(d.feed([0x61], 0), false); // 'a'
    assert.equal(d.feed([0x1b], 0), true); // esc
    // a bare ESC is NOT an ESC-led sequence (arrow key) → no false positive
    const d2 = new AfkDetector(parseAfkKey("esc", 400));
    assert.equal(d2.feed([0x1b, 0x5b, 0x41], 0), false); // up arrow
});

test("detector: 2-combo fires only when 2nd is within the window", () => {
    const d = new AfkDetector(parseAfkKey("esc esc", 400));
    assert.equal(d.feed([0x1b], 0), false); // first esc
    assert.equal(d.feed([0x1b], 200), true); // second esc within 400ms → fire
});

test("detector: 2nd combo past the window does not fire (restarts)", () => {
    const d = new AfkDetector(parseAfkKey("esc esc", 400));
    assert.equal(d.feed([0x1b], 0), false);
    assert.equal(d.feed([0x1b], 500), false); // too late → becomes a new first
    assert.equal(d.feed([0x1b], 600), true); // now within window of the restart
});

test("detector: an intervening keystroke resets the pending sequence", () => {
    const d = new AfkDetector(parseAfkKey("esc esc", 400));
    assert.equal(d.feed([0x1b], 0), false);
    assert.equal(d.feed([0x78], 100), false); // 'x' breaks it
    assert.equal(d.feed([0x1b], 150), false); // this is a fresh first, not the 2nd
});

test("detector: distinct 2-combo sequence (ctrl+a then d)", () => {
    const d = new AfkDetector(parseAfkKey("ctrl+a d", 400));
    assert.equal(d.feed([0x01], 0), false); // ctrl+a
    assert.equal(d.feed([0x64], 100), true); // 'd' → fire
    // wrong second key resets
    const d2 = new AfkDetector(parseAfkKey("ctrl+a d", 400));
    assert.equal(d2.feed([0x01], 0), false);
    assert.equal(d2.feed([0x65], 100), false); // 'e' ≠ 'd'
});

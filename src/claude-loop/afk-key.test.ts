// #351 / #381 — afk_key parser + AFK detector. node:test + tsx (zero deps).
// #381 (david s4r9n8): afk_key is one or more ALTERNATIVE atomic combos that
// TOGGLE (no 2-press timing sequence); a space means OR. A bare ESC is rejected
// (it doubles as claude's interrupt). `windowMs` survives only as a post-fire
// key-repeat debounce. Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAfkKey, AfkDetector } from "./afk-key.js";

// ---- parseAfkKey (pure: notation → byte combos) ----------------------

test("parseAfkKey: single combos → byte sequences", () => {
    assert.deepEqual(parseAfkKey("ctrl+a", 400).combos, [[0x01]]);
    assert.deepEqual(parseAfkKey("ctrl+]", 400).combos, [[0x1d]]);
    assert.deepEqual(parseAfkKey("ctrl+g", 400).combos, [[0x07]]);
    assert.deepEqual(parseAfkKey("a", 400).combos, [[0x61]]);
    assert.deepEqual(parseAfkKey("alt+a", 400).combos, [[0x1b, 0x61]]);
    assert.deepEqual(parseAfkKey("f9", 400).combos, [[0x1b, 0x5b, 0x32, 0x30, 0x7e]]);
});

test("parseAfkKey: space = alternatives (any toggles), windowMs carried", () => {
    const spec = parseAfkKey("ctrl+g alt+a", 250);
    assert.deepEqual(spec.combos, [[0x07], [0x1b, 0x61]]);
    assert.equal(spec.windowMs, 250);
});

test("parseAfkKey: rejects empty / bare-ESC / bad ctrl / unknown key", () => {
    assert.throws(() => parseAfkKey("", 400));
    assert.throws(() => parseAfkKey("   ", 400));
    assert.throws(() => parseAfkKey("esc", 400));      // bare ESC = interrupt key
    assert.throws(() => parseAfkKey("ctrl+g esc", 400)); // any combo bare-ESC
    assert.throws(() => parseAfkKey("ctrl+esc", 400)); // ctrl needs single char
    assert.throws(() => parseAfkKey("f99", 400));      // unknown named key
});

// ---- AfkDetector (stateful, clock injected) --------------------------

test("detector: a combo match TOGGLES (fires each press), ignores others", () => {
    const d = new AfkDetector(parseAfkKey("alt+a", 400));
    assert.equal(d.feed([0x61], 0), false);            // 'a' alone ≠ alt+a
    assert.equal(d.feed([0x1b, 0x61], 0), true);       // alt+a → fire (ON)
    assert.equal(d.feed([0x1b, 0x61], 1000), true);    // alt+a again → fire (OFF)
});

test("detector: an ESC-led arrow key is not a combo (no false positive)", () => {
    const d = new AfkDetector(parseAfkKey("alt+a", 400));
    assert.equal(d.feed([0x1b, 0x5b, 0x41], 0), false); // up arrow
});

test("detector: #381 key-repeat debounce — held chord toggles once", () => {
    const d = new AfkDetector(parseAfkKey("alt+a", 400));
    assert.equal(d.feed([0x1b, 0x61], 0), true);       // fire → cooldown until 400
    // key-repeat within the window: swallowed (residual), no re-toggle.
    assert.equal(d.feed([0x1b, 0x61], 100), false);
    assert.equal(d.residual, true);
    assert.equal(d.feed([0x1b, 0x61], 300), false);
    assert.equal(d.residual, true);
    // past the window: a clean press fires again.
    assert.equal(d.feed([0x1b, 0x61], 600), true);
    assert.equal(d.residual, false);
});

test("detector: a non-combo key during cooldown ends it (human is back)", () => {
    const d = new AfkDetector(parseAfkKey("ctrl+g", 400));
    assert.equal(d.feed([0x07], 0), true);             // fire → cooldown until 400
    assert.equal(d.feed([0x61], 100), false);          // 'a' ≠ combo byte → ends cooldown
    assert.equal(d.residual, false);
    assert.equal(d.feed([0x07], 150), true);           // usable immediately → fire
});

test("detector: alternatives — any configured combo fires", () => {
    const d = new AfkDetector(parseAfkKey("ctrl+g alt+a", 400));
    assert.equal(d.feed([0x07], 0), true);             // ctrl+g → fire
    assert.equal(d.feed([0x1b, 0x61], 1000), true);    // alt+a → fire
});

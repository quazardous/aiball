import { test } from "node:test";
import assert from "node:assert/strict";
import { render, renderSlot } from "./prompt-templates.js";

// #400: the placeholder grammar — {var} / {var:-default} / {var:+text}.
test("#400 render: plain {var} substitutes, empty when absent", () => {
    assert.equal(render("hi {name}", { name: "alice" }), "hi alice");
    assert.equal(render("hi {name}", {}), "hi ");
    assert.equal(render("hi {name}", { name: "" }), "hi ");
});

test("#400 render: {var:-default} uses the default only when empty", () => {
    assert.equal(render("{x:-fallback}", { x: "v" }), "v");
    assert.equal(render("{x:-fallback}", {}), "fallback");
    assert.equal(render("{x:-fallback}", { x: "" }), "fallback");
});

test("#400 render: {var:+text} includes text only when var is non-empty", () => {
    assert.equal(render("a{n:+ have {n}}", { n: 3 }), "a have 3");
    assert.equal(render("a{n:+ have {n}}", { n: "" }), "a"); // empty → dropped
    assert.equal(render("a{n:+ have {n}}", {}), "a");
    // Engine is shell-pure: 0 stringifies to "0" (non-empty) → present. Callers
    // that want a zero count to DROP pass `count || ""` (see buildContextPhrase).
    assert.equal(render("a{n:+ have {n}}", { n: 0 }), "a have 0");
});

test("#400 render: literal braces inside a :+ body survive (tool-call syntax)", () => {
    const tpl = "{pings:+ drain via `unread({pings: true, mark_read: true})`}";
    assert.equal(
        render(tpl, { pings: 2 }),
        " drain via `unread({pings: true, mark_read: true})`",
    );
    assert.equal(render(tpl, { pings: "" }), ""); // caller passes "" for zero
});

test("#400 render: a non-placeholder {x: y} is emitted literally", () => {
    assert.equal(render("call `f({actionable: true})`", {}), "call `f({actionable: true})`");
});

test("#400 render: callback values + nested defaults", () => {
    assert.equal(render("{culture}", { culture: () => "Geronimo" }), "Geronimo");
    assert.equal(render("{a:-{b}}", { b: "fromB" }), "fromB");
});

test("#400 renderSlot: string slot, list pick, fallback", () => {
    assert.equal(renderSlot({ s: "hi {x}" }, "s", { x: "!" }), "hi !");
    assert.equal(renderSlot({ s: ["only {x}"] }, "s", { x: "1" }), "only 1");
    assert.equal(renderSlot({}, "missing", { x: "1" }, "fb {x}"), "fb 1");
});

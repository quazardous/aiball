import { test } from "node:test";
import assert from "node:assert/strict";
import { render, renderSlot, loadPromptsFromYamlBlock } from "./prompt-templates.js";

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

// #400 recadré (david b296px): tone is back as a SELECTION layer over the grammar.
test("#400 recadré renderSlot: tone bucket selects slot[tone]", () => {
    const map = { s: { directive: "do {x}", hint: "maybe {x}", imperative: "DO {x}" } };
    assert.equal(renderSlot(map, "s", { x: "it" }, "", "hint"), "maybe it");
    assert.equal(renderSlot(map, "s", { x: "it" }, "", "imperative"), "DO it");
    assert.equal(renderSlot(map, "s", { x: "it" }, "", "directive"), "do it");
});

test("#400 recadré renderSlot: missing tone falls back to directive", () => {
    const map = { s: { directive: "default wording", hint: "soft" } };
    // 'imperative' absent → directive bucket.
    assert.equal(renderSlot(map, "s", {}, "", "imperative"), "default wording");
    // no tone arg → DEFAULT_TONE (directive).
    assert.equal(renderSlot(map, "s", {}), "default wording");
});

test("#400 recadré renderSlot: round-robin WITHIN a tone bucket", () => {
    // Single-element list → deterministic, proves the array path runs inside a tone.
    assert.equal(renderSlot({ s: { directive: ["only {x}"] } }, "s", { x: "1" }, "", "directive"), "only 1");
});

test("#400 recadré renderSlot: tone bucket with neither tone nor directive → fallback", () => {
    assert.equal(renderSlot({ s: { hint: "soft" } }, "s", { x: "1" }, "fb {x}", "imperative"), "fb 1");
});

// #400 (david 54phhg): `_`-prefixed slots are reusable {_name} partials.
test("#400 partials: {_name} expands a string partial", () => {
    assert.equal(renderSlot({ _drain: "drain it", s: "go — {_drain}." }, "s"), "go — drain it.");
});

test("#400 partials: a partial can be a round-robin list", () => {
    // Single element → deterministic, proves the list path runs for a partial.
    assert.equal(renderSlot({ _x: ["only"], s: "{_x}" }, "s"), "only");
});

test("#400 partials: a partial is tone-aware (resolved at the active tone)", () => {
    const map = { _drain: { directive: "DRAIN", hint: "drain maybe" }, s: "{_drain}" };
    assert.equal(renderSlot(map, "s", {}, "", "hint"), "drain maybe");
    assert.equal(renderSlot(map, "s", {}, "", "imperative"), "DRAIN"); // fallback directive
});

test("#400 partials: usable inside a {x:+…} body, dropped when the var is empty", () => {
    const map = { _drain: "via `unread({pings: true})`", s: "{p:+ {p} ping(s) — {_drain}.}" };
    assert.equal(renderSlot(map, "s", { p: 2 }), " 2 ping(s) — via `unread({pings: true})`.");
    assert.equal(renderSlot(map, "s", { p: "" }), "");
});

test("#400 partials: partials may nest, and a cycle renders \"\" (no hang)", () => {
    assert.equal(renderSlot({ _a: "A+{_b}", _b: "B", s: "{_a}" }, "s"), "A+B");
    // _a → _b → _a : the back-reference hits the cycle guard and renders "".
    assert.equal(renderSlot({ _a: "a{_b}", _b: "b{_a}", s: "{_a}" }, "s"), "ab");
});

test("#400 recadré loadPromptsFromYamlBlock: accepts the tone-bucket shape", () => {
    const block = {
        wake_lead: { directive: ["fyi:"], hint: ["btw,"] },
        wake_master: { directive: "{culture}" },
        bad: { directive: 42 }, // non-string value → whole slot dropped
        plain: "kept",
    };
    const map = loadPromptsFromYamlBlock(block);
    assert.deepEqual(map.wake_lead, { directive: ["fyi:"], hint: ["btw,"] });
    assert.deepEqual(map.wake_master, { directive: "{culture}" });
    assert.equal(map.plain, "kept");
    assert.equal("bad" in map, false);
});

// #749 david `5qrrsd` — wake_master differentiates ping-event drain vs
// backlog-by-priority drain via the `head_kind` / `backlog_mode` vars.
const WAKE_TEMPLATE =
    "{ping_count:+ {ping_count} unread ping(s) — drain via `unread()`.}"
    + "{head_kind:+ first up: {head_kind} on #{head_id}{head_title:+ \"{head_title}\"} — `ticket_claim()`.}"
    + "{backlog_mode:+ engage #{head_id}{head_title:+ \"{head_title}\"} — top of the backlog by priority — via `ticket_claim()`.}"
    + "{open_count:+ ({open_count} open)}";

test("#749 wake_master: pings>0 + comment head → 'first up' line, no backlog line", () => {
    const out = render(WAKE_TEMPLATE, {
        ping_count: 3,
        head_kind: "comment",
        head_id: 769,
        head_title: "no_claim ...",
        backlog_mode: "",
        open_count: 41,
    });
    assert.match(out, /3 unread ping\(s\)/);
    assert.match(out, /first up: comment on #769 "no_claim \.\.\."/);
    assert.doesNotMatch(out, /engage #769 .* top of the backlog/);
    assert.match(out, /\(41 open\)/);
});

test("#749 wake_master: pings>0 + new ticket head → kind label says 'new ticket'", () => {
    const out = render(WAKE_TEMPLATE, {
        ping_count: 1,
        head_kind: "new ticket",
        head_id: 775,
        head_title: "Proxy node : push de la conf …",
        backlog_mode: "",
        open_count: 41,
    });
    assert.match(out, /first up: new ticket on #775 "Proxy node : push de la conf …"/);
});

test("#749 wake_master: pings=0 + backlog mode → 'engage … backlog by priority'", () => {
    const out = render(WAKE_TEMPLATE, {
        ping_count: "",
        head_kind: "",
        head_id: 752,
        head_title: "firehose",
        backlog_mode: "1",
        open_count: 41,
    });
    assert.doesNotMatch(out, /unread ping/);
    assert.doesNotMatch(out, /first up:/);
    assert.match(out, /engage #752 "firehose" — top of the backlog by priority/);
    assert.match(out, /\(41 open\)/);
});

test("#749 wake_master: head without title still renders id only (no stray quotes)", () => {
    const out = render(WAKE_TEMPLATE, {
        ping_count: 1,
        head_kind: "comment",
        head_id: 770,
        head_title: "",
        backlog_mode: "",
        open_count: 1,
    });
    assert.match(out, /first up: comment on #770 — `ticket_claim\(\)`/);
    assert.doesNotMatch(out, /#770 ""/);
});

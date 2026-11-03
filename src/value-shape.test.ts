/** #4701 — every described setting says what kind of value it takes, in one vocabulary. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA } from "./config/schema.js";
import { shapeOfConfigEntry, type ValueShape } from "./value-shape.js";

const TYPES = new Set(["number", "duration", "enum", "boolean", "boolean_or_name", "string", "path", "url"]);

test("every config.managed key has a shape, and it agrees with the fields it had", () => {
    for (const e of CONFIG_SCHEMA) {
        const s = shapeOfConfigEntry(e);
        assert.ok(TYPES.has(s.type), e.key);
        if (s.type === "number" || s.type === "duration") {
            assert.deepEqual([s.min, s.max, s.step], [e.min, e.max, e.step], e.key);
        }
        if (s.type === "enum") assert.deepEqual(s.options, e.options, e.key);
        if (e.type === "string") assert.equal(s.type, "string", e.key);
    }
});

test("whole or decimal, read from the step, the bounds and the default", () => {
    const shape = (key: string) => shapeOfConfigEntry(CONFIG_SCHEMA.find((e) => e.key === key)!) as Extract<ValueShape, { type: "number" }>;
    assert.equal(shape("tickets.backlog.blocked_multiplier").integer, false, "it steps by 0.5");
    assert.equal(shape("tickets.rules.summary_max").integer, true);
    assert.deepEqual(shapeOfConfigEntry({ type: "number", default: 1.5 }), { type: "number", integer: false });
    assert.deepEqual(shapeOfConfigEntry({ type: "number", default: 3, min: 0 }), { type: "number", integer: true, min: 0 });
});

test("a string says whether it holds lines, and what a refused value should have been", () => {
    const prompt = shapeOfConfigEntry(CONFIG_SCHEMA.find((e) => e.key === "claude_loop.on_repetitive_denied.prompt")!);
    assert.deepEqual(prompt, { type: "string", multiline: true });
    const tz = shapeOfConfigEntry(CONFIG_SCHEMA.find((e) => e.key === "display.timezone")!) as Extract<ValueShape, { type: "string" }>;
    assert.equal(tz.multiline, false);
    assert.ok(tz.hint, "the timezone says what it takes");
});

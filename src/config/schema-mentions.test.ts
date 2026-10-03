/**
 * #3532 — a setting's label or description that names another setting names
 * one that exists: a key renamed left `tickets.step_after_max_minutes` in a
 * description, where tvty showed (and translated) a name nobody can set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, groupOf } from "./schema.js";

const KNOWN = new Set([...CONFIG_SCHEMA.map((e) => e.key), ...CONFIG_SCHEMA.map((e) => groupOf(e.key))]);
const MENTION = /\b(?:tickets|autopoll|claude_loop|updates)\.[a-z_]+(?:\.[a-z_]+)*/g;

test("every setting a label or a description names is a key or a section of the schema", () => {
    const stale: string[] = [];
    for (const e of CONFIG_SCHEMA) {
        for (const text of [e.label, e.description]) {
            for (const m of text.match(MENTION) ?? []) if (!KNOWN.has(m)) stale.push(`${e.key}: ${m}`);
        }
    }
    assert.deepEqual(stale, []);
});

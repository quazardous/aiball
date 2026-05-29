// #449 — pure tests for the config layering + schema helpers. node:test, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    allowsGlobalOverride,
    allowsProjectOverride,
    coerceConfigValue,
    effectiveSources,
    type ConfigSchemaEntry,
} from "./schema.js";
import { resolveConfigValue } from "../db/config-overrides.js";

test("resolveConfigValue: project beats global beats default", () => {
    assert.equal(resolveConfigValue("normal", undefined, undefined), "normal"); // default
    assert.equal(resolveConfigValue("normal", "high", undefined), "high"); // global override
    assert.equal(resolveConfigValue("normal", "high", "low"), "low"); // project wins
    assert.equal(resolveConfigValue("normal", undefined, "urgent"), "urgent"); // project, no global
    // falsy-but-present overrides are honored (not treated as absent)
    assert.equal(resolveConfigValue(true, false, undefined), false);
    assert.equal(resolveConfigValue(10, 0, undefined), 0);
});

test("allows*Override: by scope", () => {
    const g: ConfigSchemaEntry = { key: "g", scope: "global", type: "boolean", default: false, label: "", description: "" };
    const gp: ConfigSchemaEntry = { key: "gp", scope: "global+project", type: "boolean", default: false, label: "", description: "" };
    const p: ConfigSchemaEntry = { key: "p", scope: "project", type: "boolean", default: false, label: "", description: "" };
    assert.deepEqual([allowsGlobalOverride(g), allowsProjectOverride(g)], [true, false]);
    assert.deepEqual([allowsGlobalOverride(gp), allowsProjectOverride(gp)], [true, true]);
    assert.deepEqual([allowsGlobalOverride(p), allowsProjectOverride(p)], [false, true]);
});

test("coerceConfigValue: types + rejection", () => {
    const bool: ConfigSchemaEntry = { key: "b", scope: "global", type: "boolean", default: false, label: "", description: "" };
    assert.equal(coerceConfigValue(bool, true), true);
    assert.equal(coerceConfigValue(bool, "false"), false);
    assert.equal(coerceConfigValue(bool, "nope"), null);

    const num: ConfigSchemaEntry = { key: "n", scope: "global", type: "number", default: 1, label: "", description: "" };
    assert.equal(coerceConfigValue(num, "42"), 42);
    assert.equal(coerceConfigValue(num, 3.5), 3.5);
    assert.equal(coerceConfigValue(num, "x"), null);

    const en: ConfigSchemaEntry = { key: "e", scope: "global", type: "enum", options: ["low", "high"], default: "low", label: "", description: "" };
    assert.equal(coerceConfigValue(en, "high"), "high");
    assert.equal(coerceConfigValue(en, "mid"), null);

    const str: ConfigSchemaEntry = { key: "s", scope: "global", type: "string", default: "", label: "", description: "" };
    assert.equal(coerceConfigValue(str, "hello"), "hello");
    assert.equal(coerceConfigValue(str, 5), null);
});

// #590 — effectiveSources : default `["db"]` for backwards compat, single-source
// returned as-is, dual-source ordered by `precedence` (default `"db"`).
test("effectiveSources: unset sources → default ['db'] (backwards compat)", () => {
    const e: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "" };
    assert.deepEqual(effectiveSources(e), ["db"]);
});

test("effectiveSources: single source returned as-is", () => {
    const dbOnly: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "", sources: ["db"] };
    const fileOnly: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "", sources: ["file"] };
    assert.deepEqual(effectiveSources(dbOnly), ["db"]);
    assert.deepEqual(effectiveSources(fileOnly), ["file"]);
});

test("effectiveSources: dual source defaults to db-first", () => {
    const both: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "", sources: ["db", "file"] };
    assert.deepEqual(effectiveSources(both), ["db", "file"]);
    // Author-listed order doesn't matter — db wins by default.
    const reversed: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "", sources: ["file", "db"] };
    assert.deepEqual(effectiveSources(reversed), ["db", "file"]);
});

test("effectiveSources: precedence='file' makes file-first", () => {
    const fileWins: ConfigSchemaEntry = { key: "k", scope: "global", type: "boolean", default: false, label: "", description: "", sources: ["db", "file"], precedence: "file" };
    assert.deepEqual(effectiveSources(fileWins), ["file", "db"]);
});

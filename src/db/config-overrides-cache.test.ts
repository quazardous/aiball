/**
 * #3383 — the overrides are kept in memory between reads: a change is read at
 * once whoever makes it (set, unset, a project renamed), and a row written
 * past the writers is read after the ceiling at the latest.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3383-cfg-"));
process.env.AIBALL_SOCK = "";
after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

const { getDb } = await import("./connection.js");
const { createProject, renameProject } = await import("./projects.js");
const { getConfig, setConfigOverride, deleteConfigOverride, forgetConfigOverrides } = await import("./config-overrides.js");
const schema = await import("../schema.js");

const KEY = "tickets.wait_credit.max";

test("a set, an unset and a project renamed are read at the next read", () => {
    createProject({ name: "cfg" });
    const def = getConfig(KEY, "cfg");
    setConfigOverride("", KEY, 7);
    assert.equal(getConfig(KEY, "cfg"), 7, "the global layer");
    setConfigOverride("cfg", KEY, 9);
    assert.equal(getConfig(KEY, "cfg"), 9, "the project's over the global");
    deleteConfigOverride("cfg", KEY);
    assert.equal(getConfig(KEY, "cfg"), 7);
    setConfigOverride("cfg", KEY, 11);
    renameProject("cfg", "cfg2");
    assert.equal(getConfig(KEY, "cfg2"), 11, "the override followed the project");
    assert.equal(getConfig(KEY, "cfg"), 7, "nothing left under the old name");
    deleteConfigOverride("", KEY);
    assert.equal(getConfig(KEY, "other"), def);
});

test("a row written past the writers is read once the copy is forgotten", () => {
    assert.notEqual(getConfig(KEY, "direct"), 13);
    getDb().insert(schema.configOverrides).values({ project: "direct", key: KEY, value: "13", updatedAt: new Date().toISOString(), updatedBy: null }).run();
    forgetConfigOverrides();
    assert.equal(getConfig(KEY, "direct"), 13);
});

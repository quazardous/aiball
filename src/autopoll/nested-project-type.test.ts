// #2130 — `project_type` inherits from the nearest ancestor project, and
// NOTHING else does. Real directories on disk, because the behaviour under
// test IS the upward filesystem walk — a fixture that stubbed it away would
// pass while the walk stayed broken (the lesson of #2112's dead `closed` flag).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

/**
 * Run `fn` with the ambient aiball identity cleared.
 *
 * `loadConfig` gives `AIBALL_PROJECT` / `AIBALL_AGENT` priority over the yaml —
 * correctly, that is the documented chain — and every agent session exports
 * them. A test that asserts what the FILES resolve to must therefore neutralise
 * the environment itself, or it only passes on the machine that happened to be
 * clean. This one asserted `project === "child"` and got `"aiball"` the first
 * time it ran anywhere but my hand-cleared shell.
 */
function withoutAmbientIdentity<T>(fn: () => T): T {
    const saved = {
        project: process.env.AIBALL_PROJECT,
        agent: process.env.AIBALL_AGENT,
        cwd: process.env.AIBALL_CWD,
    };
    delete process.env.AIBALL_PROJECT;
    delete process.env.AIBALL_AGENT;
    delete process.env.AIBALL_CWD;
    try {
        return fn();
    } finally {
        if (saved.project !== undefined) process.env.AIBALL_PROJECT = saved.project;
        if (saved.agent !== undefined) process.env.AIBALL_AGENT = saved.agent;
        if (saved.cwd !== undefined) process.env.AIBALL_CWD = saved.cwd;
    }
}

/** A tree: `<root>/parent/.aiball.yaml` + `<root>/parent/child/.aiball.yaml`. */
function makeTree(parentYaml: string, childYaml: string) {
    const root = mkdtempSync(join(tmpdir(), "aiball-nested-"));
    const parent = join(root, "parent");
    const child = join(parent, "child");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, ".aiball.yaml"), parentYaml);
    writeFileSync(join(child, ".aiball.yaml"), childYaml);
    return { root, parent, child };
}

test("a nested project inherits its parent's project_type", () => {
    const { root, parent, child } = makeTree("project_type: private\n", "autopoll:\n  enabled: true\n");
    try {
        withoutAmbientIdentity(() => {
            assert.equal(loadConfig(parent).project_type, "private");
            assert.equal(loadConfig(child).project_type, "private", "the child was treated as public");
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the child's own project_type wins over the parent's", () => {
    const { root, child } = makeTree("project_type: private\n", "project_type: public\n");
    try {
        withoutAmbientIdentity(() => {
            assert.equal(loadConfig(child).project_type, "public");
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("identity does NOT inherit — the child stays its own project", () => {
    // The load-bearing half. Inheriting the identity block would file the
    // child's tickets in the parent's project, which is the bug this feature
    // must not introduce while fixing the other one.
    const { root, child } = makeTree(
        "project_type: private\nconsumer:\n  project: theparent\n  agent: parent-agent\n",
        "autopoll:\n  enabled: true\n",
    );
    try {
        withoutAmbientIdentity(() => {
            const cfg = loadConfig(child);
            assert.equal(cfg.consumer.project, "child", "the child took its parent's project name");
            assert.equal(cfg.consumer.agent, "child-claude");
            assert.equal(cfg.project_type, "private", "…but the type still inherits");
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("no ancestor config leaves the type unset rather than inventing one", () => {
    const root = mkdtempSync(join(tmpdir(), "aiball-nested-"));
    const solo = join(root, "solo");
    mkdirSync(solo, { recursive: true });
    writeFileSync(join(solo, ".aiball.yaml"), "autopoll:\n  enabled: true\n");
    try {
        withoutAmbientIdentity(() => {
            assert.equal(loadConfig(solo).project_type, null);
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// #2201 — `claude.deny_tools` in a tree's `.aiball.yaml` must end up as the
// `permissions.deny` of the settings claude-loop spawns claude with. Real files
// on disk and the real `loadConfig`, because the path under test is the whole
// chain yaml → config → settings; a stub at either end would pass while the
// other end stayed disconnected.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../autopoll/config.js";
import { buildSpawnSettings } from "./spawn-settings.js";

/** `loadConfig` lets AIBALL_PROJECT / AIBALL_AGENT override the yaml, and every
 *  agent session exports them — clear them so the FILE is what gets read. */
function withoutAmbientIdentity<T>(fn: () => T): T {
    const saved = { project: process.env.AIBALL_PROJECT, agent: process.env.AIBALL_AGENT, cwd: process.env.AIBALL_CWD };
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

function treeWith(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "aiball-deny-"));
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    return dir;
}

const HOOKS = { SessionStart: [] };

test("deny_tools in the yaml becomes the permissions.deny claude is spawned with", () => {
    const dir = treeWith("project: p-deny\nagent: cto\nclaude:\n  deny_tools: [Read, \" Bash \", Read, 42, \"\"]\n");
    try {
        const cfg = withoutAmbientIdentity(() => loadConfig(dir));
        // trimmed, de-duplicated, non-strings and blanks dropped
        assert.deepEqual(cfg.claude.deny_tools, ["Read", "Bash"]);
        assert.deepEqual(buildSpawnSettings(HOOKS, cfg.claude.deny_tools), {
            hooks: HOOKS,
            permissions: { deny: ["Read", "Bash"] },
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a tree that declares nothing spawns with no permissions block at all", () => {
    const dir = treeWith("project: p-plain\nagent: coder\n");
    try {
        const cfg = withoutAmbientIdentity(() => loadConfig(dir));
        assert.deepEqual(cfg.claude.deny_tools, []);
        const settings = buildSpawnSettings(HOOKS, cfg.claude.deny_tools);
        assert.equal("permissions" in settings, false, "no empty deny block written just in case");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

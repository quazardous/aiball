// #4120 — the Claude config dir a project's loops run with: the project's key, else the env, else ~/.claude.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, expandConfigDir } from "./claude-config-dir.js";

const root = mkdtempSync(join(tmpdir(), "ccd-"));
after(() => rmSync(root, { recursive: true, force: true }));
const HOME = "/home/someone";

function project(name: string, yaml: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".aiball.yaml"), yaml);
    return dir;
}

test("a configured value: ~ expanded, a relative path taken from the folder", () => {
    assert.equal(expandConfigDir("~", "/p", HOME), HOME);
    assert.equal(expandConfigDir("~/.claude-work", "/p", HOME), `${HOME}/.claude-work`);
    assert.equal(expandConfigDir("/abs/dir", "/p", HOME), "/abs/dir");
    assert.equal(expandConfigDir("profiles/work", "/p/proj", HOME), "/p/proj/profiles/work");
});

test("the project's claude.config_dir wins; its .claude.json lives inside it", () => {
    const proj = project("a", "consumer:\n  project: a\nclaude:\n  config_dir: ~/.claude-work\n");
    assert.deepEqual(claudeConfigDir(proj, { CLAUDE_CONFIG_DIR: "/env/dir" }, HOME), {
        dir: `${HOME}/.claude-work`, json: `${HOME}/.claude-work/.claude.json`, from: "file",
    });
});

test("no key: the environment's dir, else ~/.claude with ~/.claude.json", () => {
    const proj = project("b", "consumer:\n  project: b\n");
    assert.deepEqual(claudeConfigDir(proj, { CLAUDE_CONFIG_DIR: "/env/dir" }, HOME), { dir: "/env/dir", json: "/env/dir/.claude.json", from: "env" });
    assert.deepEqual(claudeConfigDir(proj, {}, HOME), { dir: `${HOME}/.claude`, json: `${HOME}/.claude.json`, from: "default" });
    assert.equal(claudeConfigDir(null, {}, HOME).from, "default");
});

test("the sessions offered for resume are read in the project's config dir", async () => {
    const { claudeProjectDir } = await import("./claude-loop/claude-conversations.js");
    const proj = project("c", `consumer:\n  project: c\nclaude:\n  config_dir: ${join(root, "cfg-c")}\n`);
    assert.ok(claudeProjectDir(proj).startsWith(join(root, "cfg-c", "projects")), claudeProjectDir(proj));
});

test("a loop starts Claude with the project's dir: its env file exports it", async () => {
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync(new URL("./claude-loop/cli.ts", import.meta.url), "utf8");
    assert.match(cli, /ctx\.claude\.config_dir \? \[`export CLAUDE_CONFIG_DIR=\$\{shQuote\(expandConfigDir\(ctx\.claude\.config_dir, cwd\)\)\}`\]/);
});

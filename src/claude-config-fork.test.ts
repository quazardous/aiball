// #4125 — `aiball claude-config <dir> --fork`: the new dir gets the old one's mind, never its account nor its sessions.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkClaudeConfig } from "./claude-config-fork.js";

const root = mkdtempSync(join(tmpdir(), "ccf-"));
after(() => rmSync(root, { recursive: true, force: true }));

function source(name: string): { dir: string; json: string } {
    const dir = join(root, name);
    mkdirSync(join(dir, "skills", "s1"), { recursive: true });
    mkdirSync(join(dir, "projects", "-p"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "@RTK.md\n\nrules\n");
    writeFileSync(join(dir, "RTK.md"), "rtk\n");
    writeFileSync(join(dir, "NOTES.md"), "not imported\n");
    writeFileSync(join(dir, "settings.json"), "{\"model\":\"x\"}");
    writeFileSync(join(dir, "settings.json.bak"), "{}");
    writeFileSync(join(dir, "skills", "s1", "SKILL.md"), "skill\n");
    writeFileSync(join(dir, ".credentials.json"), "{\"secret\":1}");
    writeFileSync(join(dir, "history.jsonl"), "h\n");
    writeFileSync(join(dir, "projects", "-p", "s.jsonl"), "t\n");
    writeFileSync(join(dir, "brand-new-thing"), "?");
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { email: "a@b" }, hasCompletedOnboarding: true, userID: "u", mcpServers: { aiball: { command: "x" } } }));
    return { dir, json: join(dir, ".claude.json") };
}

test("the mind goes, the identity and the past stay", () => {
    const from = source("a");
    const to = { dir: join(root, "a-new"), json: join(root, "a-new", ".claude.json") };
    const r = forkClaudeConfig(from, to);
    assert.deepEqual(r.copied, ["CLAUDE.md", "RTK.md", "settings.json", "skills"]);
    assert.equal(readFileSync(join(to.dir, "skills", "s1", "SKILL.md"), "utf8"), "skill\n");
    for (const never of [".credentials.json", "history.jsonl", "projects", "NOTES.md", "settings.json.bak"]) {
        assert.equal(existsSync(join(to.dir, never)), false, never);
    }
    assert.deepEqual(r.unknown, ["NOTES.md", "brand-new-thing"], "an entry the table does not know is named, not copied");
    assert.deepEqual(JSON.parse(readFileSync(to.json, "utf8")), { mcpServers: { aiball: { command: "x" } } }, "only mcpServers leave .claude.json");
    assert.equal(r.mcpServers, 1);
});

test("what the new dir has is kept, unless force", () => {
    const from = source("b");
    const to = { dir: join(root, "b-new"), json: join(root, "b-new", ".claude.json") };
    mkdirSync(to.dir, { recursive: true });
    writeFileSync(join(to.dir, "settings.json"), "{\"mine\":1}");
    writeFileSync(to.json, JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { aiball: { command: "mine" } } }));
    const r = forkClaudeConfig(from, to);
    assert.deepEqual(r.kept, ["settings.json"]);
    assert.equal(readFileSync(join(to.dir, "settings.json"), "utf8"), "{\"mine\":1}");
    assert.equal(r.mcpServers, 0);
    assert.equal(JSON.parse(readFileSync(to.json, "utf8")).mcpServers.aiball.command, "mine");

    const f = forkClaudeConfig(from, to, { force: true });
    assert.ok(f.copied.includes("settings.json"));
    assert.equal(readFileSync(join(to.dir, "settings.json"), "utf8"), "{\"model\":\"x\"}");
    const json = JSON.parse(readFileSync(to.json, "utf8"));
    assert.equal(json.mcpServers.aiball.command, "x");
    assert.equal(json.hasCompletedOnboarding, true, "the new dir's own first-run state stays");
    assert.equal(json.oauthAccount, undefined);
});

test("no source dir: nothing done", () => {
    const r = forkClaudeConfig({ dir: join(root, "none"), json: join(root, "none.json") }, { dir: join(root, "x"), json: join(root, "x", ".claude.json") });
    assert.deepEqual(r, { copied: [], kept: [], unknown: [], mcpServers: 0 });
});

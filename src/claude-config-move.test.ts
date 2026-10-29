// #4120 — `aiball claude-config <dir> --move-sessions`: the folder's Claude sessions follow it to the new dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveClaudeSessions } from "./claude-config-move.js";
import type { ClaudeConfigDir } from "./claude-config-dir.js";

const root = mkdtempSync(join(tmpdir(), "ccm-"));
after(() => rmSync(root, { recursive: true, force: true }));

const folder = "/work/proj";
const key = "-work-proj";
const dirOf = (name: string): ClaudeConfigDir => ({ dir: join(root, name), json: join(root, name, ".claude.json"), from: "file" });

test("transcripts move, the project's .claude.json entry is carried, other projects stay", () => {
    const from = dirOf("old"), to = dirOf("new");
    mkdirSync(join(from.dir, "projects", key), { recursive: true });
    mkdirSync(join(from.dir, "projects", "-other"), { recursive: true });
    writeFileSync(join(from.dir, "projects", key, "s1.jsonl"), "a\n");
    writeFileSync(join(from.dir, "projects", key, "s2.jsonl"), "b\n");
    writeFileSync(join(from.dir, "projects", "-other", "o.jsonl"), "o\n");
    writeFileSync(from.json, JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true }, "/else": { x: 1 } } }));
    const r = moveClaudeSessions(folder, from, to);
    assert.deepEqual(r, { moved: 2, replaced: [], projectEntry: "copied" });
    assert.equal(readFileSync(join(to.dir, "projects", key, "s1.jsonl"), "utf8"), "a\n");
    assert.equal(existsSync(join(from.dir, "projects", key)), false, "the emptied dir goes");
    assert.ok(existsSync(join(from.dir, "projects", "-other", "o.jsonl")), "another project's sessions stay");
    assert.deepEqual(JSON.parse(readFileSync(to.json, "utf8")).projects, { [folder]: { hasTrustDialogAccepted: true } });
    assert.deepEqual(JSON.parse(readFileSync(from.json, "utf8")).projects, { "/else": { x: 1 } });
});

// #4419 — back to a dir the folder used before: what is on both sides is merged, never lost.
const NOW = new Date("2026-10-29T12:00:00Z");
const T_OLD = new Date("2026-10-01T00:00:00Z"), T_NEW = new Date("2026-10-20T00:00:00Z");
function put(file: string, text: string, at: Date): void {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    utimesSync(file, at, at);
}

test("a switch back merges: the newer copy of a file wins, the older goes aside, a directory on both sides is merged", () => {
    const from = dirOf("b"), to = dirOf("a");
    const src = join(from.dir, "projects", key), dst = join(to.dir, "projects", key);
    put(join(src, "s1.jsonl"), "continued in b\n", T_NEW);   // the conversation went on in b
    put(join(dst, "s1.jsonl"), "stale in a\n", T_OLD);
    put(join(src, "s0.jsonl"), "older in b\n", T_OLD);       // a ran it later: a's stays
    put(join(dst, "s0.jsonl"), "newer in a\n", T_NEW);
    put(join(src, "memory", "MEMORY.md"), "b index\n", T_NEW);
    put(join(src, "memory", "only-b.md"), "b\n", T_NEW);
    put(join(dst, "memory", "MEMORY.md"), "a index\n", T_OLD);
    put(join(dst, "memory", "only-a.md"), "a\n", T_OLD);
    const r = moveClaudeSessions(folder, from, to, NOW);
    const aside = join(to.dir, ".replaced-by-move-2026-10-29", key);
    assert.equal(readFileSync(join(dst, "s1.jsonl"), "utf8"), "continued in b\n");
    assert.equal(readFileSync(join(aside, "s1.jsonl"), "utf8"), "stale in a\n");
    assert.equal(readFileSync(join(dst, "s0.jsonl"), "utf8"), "newer in a\n");
    assert.equal(readFileSync(join(aside, "s0.jsonl"), "utf8"), "older in b\n");
    assert.equal(readFileSync(join(dst, "memory", "MEMORY.md"), "utf8"), "b index\n");
    assert.equal(readFileSync(join(aside, "memory", "MEMORY.md"), "utf8"), "a index\n");
    assert.deepEqual(readdirSync(join(dst, "memory")).sort(), ["MEMORY.md", "only-a.md", "only-b.md"]);
    assert.equal(existsSync(src), false, "nothing is left behind in the old dir");
    assert.equal(r.moved, 3, "s1, MEMORY.md and only-b.md took their place");
    assert.deepEqual(r.replaced.map((x) => x.path).sort(), [join(dst, "memory", "MEMORY.md"), join(dst, "s0.jsonl"), join(dst, "s1.jsonl")].sort());
});

test("a second move the same day does not overwrite what the first set aside", () => {
    const from = dirOf("c"), to = dirOf("d");
    const src = join(from.dir, "projects", key), dst = join(to.dir, "projects", key);
    const aside = join(to.dir, ".replaced-by-move-2026-10-29", key);
    put(join(aside, "s1.jsonl"), "first aside\n", T_OLD);
    put(join(src, "s1.jsonl"), "new\n", T_NEW);
    put(join(dst, "s1.jsonl"), "old\n", T_OLD);
    const r = moveClaudeSessions(folder, from, to, NOW);
    assert.equal(readFileSync(join(aside, "s1.jsonl"), "utf8"), "first aside\n");
    assert.equal(r.replaced[0].aside, join(aside, "s1.jsonl.1"));
    assert.equal(readFileSync(r.replaced[0].aside, "utf8"), "old\n");
});

test("the .claude.json entry is merged into the one already there: the moving one's keys win, allowedTools joined", () => {
    const from = dirOf("e"), to = dirOf("f");
    mkdirSync(from.dir, { recursive: true });
    writeFileSync(from.json, JSON.stringify({ projects: { [folder]: { hasTrustDialogAccepted: true, allowedTools: ["Bash(git *)", "Read"], mcp: "b" } } }));
    mkdirSync(to.dir, { recursive: true });
    writeFileSync(to.json, JSON.stringify({ projects: { [folder]: { allowedTools: ["Read", "Edit"], mcp: "a", onlyA: 1 }, "/else": { x: 1 } } }));
    const r = moveClaudeSessions(folder, from, to, NOW);
    assert.equal(r.projectEntry, "merged");
    const got = JSON.parse(readFileSync(to.json, "utf8")).projects;
    assert.deepEqual(got[folder], { allowedTools: ["Read", "Edit", "Bash(git *)"], mcp: "b", onlyA: 1, hasTrustDialogAccepted: true });
    assert.deepEqual(got["/else"], { x: 1 });
    assert.deepEqual(JSON.parse(readFileSync(from.json, "utf8")).projects, {}, "the entry leaves the old file");
});

test("nothing to move: nothing done", () => {
    assert.deepEqual(moveClaudeSessions(folder, dirOf("empty-a"), dirOf("empty-b")), { moved: 0, replaced: [], projectEntry: "none" });
});

// #4120 — `aiball claude-config <dir> --move-sessions`: the folder's Claude sessions follow it to the new dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(r, { moved: 2, kept: [], projectEntry: "copied" });
    assert.equal(readFileSync(join(to.dir, "projects", key, "s1.jsonl"), "utf8"), "a\n");
    assert.equal(existsSync(join(from.dir, "projects", key)), false, "the emptied dir goes");
    assert.ok(existsSync(join(from.dir, "projects", "-other", "o.jsonl")), "another project's sessions stay");
    assert.deepEqual(JSON.parse(readFileSync(to.json, "utf8")).projects, { [folder]: { hasTrustDialogAccepted: true } });
    assert.deepEqual(JSON.parse(readFileSync(from.json, "utf8")).projects, { "/else": { x: 1 } });
});

test("a session already in the new dir is kept there, the old one left in place", () => {
    const from = dirOf("old2"), to = dirOf("new2");
    mkdirSync(join(from.dir, "projects", key), { recursive: true });
    mkdirSync(join(to.dir, "projects", key), { recursive: true });
    writeFileSync(join(from.dir, "projects", key, "s1.jsonl"), "old\n");
    writeFileSync(join(to.dir, "projects", key, "s1.jsonl"), "new\n");
    writeFileSync(to.json, JSON.stringify({ projects: { [folder]: { mine: true } } }));
    writeFileSync(from.json, JSON.stringify({ projects: { [folder]: { theirs: true } } }));
    const r = moveClaudeSessions(folder, from, to);
    assert.equal(r.moved, 0);
    assert.equal(r.kept.length, 1);
    assert.equal(r.projectEntry, "already-there");
    assert.equal(readFileSync(join(to.dir, "projects", key, "s1.jsonl"), "utf8"), "new\n");
    assert.equal(readFileSync(join(from.dir, "projects", key, "s1.jsonl"), "utf8"), "old\n");
});

test("nothing to move: nothing done", () => {
    assert.deepEqual(moveClaudeSessions(folder, dirOf("empty-a"), dirOf("empty-b")), { moved: 0, kept: [], projectEntry: "none" });
});

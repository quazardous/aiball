/**
 * #3298 — `session.start` without a mode lets the loop's start decide where it
 * runs, as from a terminal: no `--host` / `--tmux` is forced on it, so its own
 * rule applies (the folder's configured mode, and tmux for a folder bound to a
 * remote daemon). A mode the caller chose is passed as it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3298-"));
process.env.AIBALL_SOCK = "";
const { loopStartArgs } = await import("./methods/session.js");

test("without a mode, no --host or --tmux: the loop's start decides", () => {
    const args = loopStartArgs({ cwd: "/w/p", agent: "p-claude" });
    assert.ok(!args.includes("--host") && !args.includes("--tmux"), args.join(" "));
    assert.deepEqual(args, ["start", "--no-attach", "--cwd", "/w/p", "--agent", "p-claude"]);
});

test("a mode the caller chose is passed as it is", () => {
    assert.deepEqual(loopStartArgs({ cwd: "/w/p", mode: "host" }).slice(0, 2), ["start", "--host"]);
    assert.deepEqual(loopStartArgs({ cwd: "/w/p", mode: "tmux", crew: "c-two" }), ["start", "--tmux", "--no-attach", "--cwd", "/w/p", "--crew", "c-two"]);
});

test("#3489 — a conversation to resume goes to the loop's start as --resume-session", () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.deepEqual(loopStartArgs({ cwd: "/w/p", agent: "p-claude", resume: id }).slice(-2), ["--resume-session", id]);
});

/**
 * #3505 — loop.restart's `resume`: the loop relaunched on a conversation of its
 * folder, refused before anything stops when the folder has none such, when
 * another agent's running loop is on it, or with `fresh`.
 */
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "aiball-3505-"));
process.env.AIBALL_HOME = join(home, "aiball");
process.env.AIBALL_SOCK = "";
// Claude Code's own files are under the user's home.
process.env.HOME = home;
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3505-tmux-");
delete process.env.TMUX;
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { tmuxName } = await import("../claude-loop/state.js");
const { claudeProjectDir } = await import("../claude-loop/claude-conversations.js");
after(() => {
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
    rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

const project = join(home, "proj");
mkdirSync(project);
const HELD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
mkdirSync(claudeProjectDir(project), { recursive: true });
writeFileSync(join(claudeProjectDir(project), `${HELD}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }));

function plate(name: string, fields: Record<string, unknown>): void {
    mkdirSync(join(home, "loops", name), { recursive: true });
    writeFileSync(join(home, "loops", name, "plate.json"), JSON.stringify({ name, created_at: "2026-10-03T00:00:00Z", ...fields }));
}
plate("cl-a", { agent: "a-one", cwd: project });
plate("cl-b", { agent: "b-one", cwd: project, session_id: HELD });
plate("cl-empty", { agent: "e-one", cwd: join(home, "empty") });
spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-b"), "sleep 60"], { stdio: "ignore" });

const human = testCaller("boss", { kind: "human" });
const restart = getMethod("loop.restart")!;

test("resume is refused before anything stops: with fresh, a conversation the folder lacks, none at all, another agent's", async () => {
    assert.equal((await refused(() => restart.run(human, { name: "cl-a", resume: "latest", fresh: true }))).status, 400);
    const unknown = await refused(() => restart.run(human, { name: "cl-a", resume: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    assert.deepEqual([unknown.status, unknown.code], [404, "NOT_FOUND"]);
    assert.equal((await refused(() => restart.run(human, { name: "cl-empty", resume: "latest" }))).status, 404);
    const held = await refused(() => restart.run(human, { name: "cl-a", resume: HELD }));
    assert.deepEqual([held.status, held.code], [409, "CONFLICT"]);
    assert.match(held.message, /b-one/);
});

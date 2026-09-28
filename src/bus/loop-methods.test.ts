// #3227 — loop.list and loop.restart's refusals, on plates in an isolated state root and an isolated tmux server.
import { test, after } from "node:test";
import { refused, testCaller } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "aiball-3227-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3227-tmux-");
delete process.env.TMUX;
const { getMethod } = await import("./methods.js");
await import("./register.js");
const { tmuxName } = await import("../claude-loop/state.js");
const { setAgentBar } = await import("../agent-bar-store.js");
after(() => {
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
    rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
});

function plate(name: string, fields: Record<string, unknown>): void {
    mkdirSync(join(home, "loops", name), { recursive: true });
    writeFileSync(join(home, "loops", name, "plate.json"), JSON.stringify({ name, created_at: "2026-09-28T00:00:00Z", cwd: `/w/${name}`, ...fields }));
}
plate("cl-t1", { agent: "t-one", project: "demo", role: "crew" });
plate("cl-h1", { agent: "h-one", host_agent: "h-one", project: "demo" });
plate("cl-old", { consumer: "old-crew" });
plate("cl-rc", { agent: "rc-one", remote_control: "phone" });

const human = testCaller("boss", { kind: "human" });
const list = () => getMethod("loop.list")!.run(human, {}) as Array<Record<string, unknown>>;
const restart = getMethod("loop.restart")!;
test("loop.list: every loop of the machine, stopped ones included, with its agent, mode and what to open", () => {
    const byName = Object.fromEntries(list().map((l) => [l.name, l]));
    assert.deepEqual(Object.keys(byName).sort(), ["cl-h1", "cl-old", "cl-rc", "cl-t1"]);
    assert.deepEqual(byName["cl-t1"], { name: "cl-t1", cwd: "/w/cl-t1", agent: "t-one", project: "demo", role: "crew", mode: "tmux", running: false, remote_control: false, tmux: tmuxName("cl-t1") });
    assert.equal(byName["cl-rc"].remote_control, "phone", "#3254 — Claude's Remote Control, as the loop started");
    assert.equal(byName["cl-h1"].mode, "host");
    assert.equal(byName["cl-h1"].running, false, "no host runs for it");
    assert.equal(byName["cl-old"].agent, "old-crew", "an older plate names its agent by consumer");
});

test("a loop in tmux whose session is there is running", () => {
    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-t1"), "sleep 60"], { stdio: "ignore" });
    assert.equal(list().find((l) => l.name === "cl-t1")?.running, true);
});

test("loop.restart refuses: a loop not here, both or neither of name/agent, over TCP, and a running loop whose Claude works", async () => {
    assert.equal((await refused(() => restart.run(human, { name: "cl-nope" }))).code, "NOT_FOUND");
    assert.equal((await refused(() => restart.run(human, { agent: "nobody" }))).code, "NOT_FOUND");
    assert.equal((await refused(() => restart.run(human, { name: "cl-t1", agent: "t-one" }))).code, "BAD_REQUEST");
    assert.equal((await refused(() => restart.run(human, {}))).code, "BAD_REQUEST");
    const tcp = testCaller("boss", { kind: "human", transport: "tcp" });
    assert.equal((await refused(() => restart.run(tcp, { name: "cl-t1" }))).status, 403);
    setAgentBar("t-one", { v: 1, phase: "busy" } as never);
    const busy = await refused(() => restart.run(human, { agent: "t-one" }));
    assert.deepEqual([busy.status, busy.code], [409, "NOT_IDLE"]);
    assert.match(busy.message, /pass force/);
});

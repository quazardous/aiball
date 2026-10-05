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
// #3461 — answered once tmux has said which sessions exist, without holding the daemon.
const list = async () => (await getMethod("loop.list")!.run(human, {})) as Array<Record<string, unknown>>;
const restart = getMethod("loop.restart")!;
test("loop.list: every loop of the machine, stopped ones included, with its agent, mode and what to open", async () => {
    const byName = Object.fromEntries((await list()).map((l) => [l.name, l]));
    assert.deepEqual(Object.keys(byName).sort(), ["cl-h1", "cl-old", "cl-rc", "cl-t1"]);
    assert.deepEqual(byName["cl-t1"], { name: "cl-t1", cwd: "/w/cl-t1", agent: "t-one", project: "demo", role: "crew", mode: "tmux", running: false, remote_control: false, model: null, afk_hold: "off", tmux: tmuxName("cl-t1"), clients: null, interactive: null, started_at: "2026-09-28T00:00:00Z", last_seen_at: null, superseded: false });
    assert.equal(byName["cl-rc"].remote_control, "phone", "#3254 — Claude's Remote Control, as the loop started");
    assert.equal(byName["cl-h1"].mode, "host");
    assert.equal(byName["cl-h1"].running, false, "no host runs for it");
    assert.equal(byName["cl-old"].agent, "old-crew", "an older plate names its agent by consumer");
});

test("a loop in tmux whose session is there is running", async () => {
    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-t1"), "sleep 60"], { stdio: "ignore" });
    assert.equal((await list()).find((l) => l.name === "cl-t1")?.running, true);
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

test("#3259 loop.wake: asks a running idle loop to wake; refuses a loop not here, a stopped one, a busy one (unless force), and TCP", async () => {
    const wake = getMethod("loop.wake")!;
    assert.equal((await refused(() => wake.run(human, { name: "cl-nope" }))).code, "NOT_FOUND");
    assert.equal((await refused(() => wake.run(human, {}))).code, "BAD_REQUEST");
    assert.equal((await refused(() => wake.run(human, { name: "cl-h1" }))).code, "LOOP_NOT_FOUND", "a loop that does not run");
    assert.equal((await refused(() => wake.run(testCaller("boss", { kind: "human", transport: "tcp" }), { name: "cl-t1" }))).status, 403);
    setAgentBar("t-one", { v: 1, phase: "busy" } as never);
    assert.equal((await refused(() => wake.run(human, { name: "cl-t1" }))).code, "NOT_IDLE");
    setAgentBar("t-one", { v: 1, phase: "idle" } as never);
    assert.deepEqual(await wake.run(human, { agent: "t-one" }), { name: "cl-t1", requested: true });
    setAgentBar("t-one", { v: 1, phase: "busy" } as never);
    assert.deepEqual(await wake.run(human, { name: "cl-t1", force: true }), { name: "cl-t1", requested: true }, "force: queued until Claude is idle");
});

// #3338 — an agent with two loops: dates to choose the latest, and the stopped
// one that another loop of its agent replaces marked as such.
test("loop.list dates each loop and marks a stopped loop its agent has replaced", async () => {
    const { markSuperseded } = await import("./methods/loop.js");
    plate("cl-dup-old", { agent: "dup", created_at: "2026-09-29T14:59:59Z" });
    plate("cl-dup-new", { agent: "dup", host_agent: "dup", created_at: "2026-09-29T15:03:33Z" });
    const byName = Object.fromEntries((await list()).map((l) => [l.name, l]));
    assert.equal(byName["cl-dup-old"].started_at, "2026-09-29T14:59:59Z");
    assert.equal(byName["cl-dup-new"].started_at, "2026-09-29T15:03:33Z");
    assert.equal(byName["cl-dup-old"].last_seen_at, null, "no log: never seen");
    assert.equal(byName["cl-dup-old"].superseded, true, "a later loop of its agent");
    assert.equal(byName["cl-dup-new"].superseded, false, "the latest");
    assert.equal(byName["cl-t1"].superseded, false, "an agent with one loop");

    const row = (name: string, agent: string | null, running: boolean, started_at: string) => ({
        name, cwd: "/w", agent, project: null, role: null, mode: "tmux" as const, running, remote_control: false,
        model: null, afk_hold: "off" as const, clients: null, interactive: null, started_at, last_seen_at: null, at: 0,
    });
    const marked = markSuperseded([
        row("later-stopped", "a", false, "2026-09-29T16:00:00Z"),
        row("earlier-running", "a", true, "2026-09-29T15:00:00Z"),
        row("orphan-1", null, false, "2026-09-29T15:00:00Z"),
        row("orphan-2", null, false, "2026-09-29T16:00:00Z"),
    ]);
    assert.deepEqual(marked.map((l) => [l.name, l.superseded]), [
        ["later-stopped", true], ["earlier-running", false], ["orphan-1", false], ["orphan-2", false],
    ], "a running loop wins over a later stopped one; loops without an agent stand alone");
    assert.equal("at" in marked[0]!, false, "the internal plate time stays inside");
});

// #3343 — the other clients of a tmux loop, made copies or detached, the caller's own kept.
test("loop.clients_readonly and loop.clients_detach act on the other clients only", async () => {
    const { spawn } = await import("node:child_process");
    const { tmuxClientList } = await import("../claude-loop/state.js");
    plate("cl-cli", { agent: "cli-3343" });
    plate("cl-hostcli", { agent: "hostcli-3343", host_agent: "hostcli-3343" });
    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-cli"), "sleep 60"], { stdio: "ignore" });
    const kids = [0, 1].map(() => spawn("tmux", ["-C", "attach", "-t", tmuxName("cl-cli")], { stdio: ["pipe", "ignore", "ignore"] }));
    try {
        const deadline = Date.now() + 5000;
        while ((tmuxClientList("cl-cli") ?? []).length < 2) {
            assert.ok(Date.now() < deadline, "the two clients never attached");
            await new Promise((r) => setTimeout(r, 50));
        }
        const keep = (tmuxClientList("cl-cli") ?? [])[0]!.pid;
        const ro = getMethod("loop.clients_readonly")!.run(human, { name: "cl-cli", keep_pid: keep }) as Record<string, unknown>;
        assert.deepEqual(ro, { name: "cl-cli", clients: 2, interactive: 1 });
        assert.equal((tmuxClientList("cl-cli") ?? []).find((c) => c.pid === keep)?.readonly, false, "the caller's own keeps the controls");
        const again = getMethod("loop.clients_readonly")!.run(human, { name: "cl-cli", keep_pid: keep }) as Record<string, unknown>;
        assert.equal(again.interactive, 1, "twice is still a copy: switch-client -r toggles, only writable ones are switched");
        const det = getMethod("loop.clients_detach")!.run(human, { name: "cl-cli", keep_pid: keep }) as Record<string, unknown>;
        assert.deepEqual(det, { name: "cl-cli", clients: 1, interactive: 1 });
        assert.equal((await refused(() => getMethod("loop.clients_detach")!.run(human, { name: "cl-hostcli" }))).status, 409, "a host loop has its own controls");
        const tcp = testCaller("boss", { kind: "human", transport: "tcp" });
        assert.equal((await refused(() => getMethod("loop.clients_detach")!.run(tcp, { name: "cl-cli" }))).status, 403);
    } finally {
        for (const k of kids) k.kill();
        spawnSync("tmux", ["kill-session", "-t", tmuxName("cl-cli")], { stdio: "ignore" });
    }
});


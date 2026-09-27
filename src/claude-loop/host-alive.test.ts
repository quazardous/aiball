/**
 * #3066 — a loop on the daemon's session host is alive while its host runs:
 * `claude-loop start` must see it so, or it wipes the loop's state and kills
 * the processes inside the host before the daemon refuses with HOST_BUSY.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { liveHostAgent, loopAlive } from "./host-alive.js";

const home = mkdtempSync(join(tmpdir(), "aiball-3066-hostalive-"));
after(() => rmSync(home, { recursive: true, force: true }));

function loop(name: string, plate: Record<string, unknown> | null): string {
    const sd = join(home, "loops", name);
    mkdirSync(sd, { recursive: true });
    if (plate) writeFileSync(join(sd, "plate.json"), JSON.stringify({ name, ...plate }));
    return sd;
}

function host(agent: string, pid: number): void {
    mkdirSync(join(home, "hosts", agent), { recursive: true });
    writeFileSync(join(home, "hosts", agent, "host.json"), JSON.stringify({ agent, pid, version: 1 }));
}

test("a loop whose host runs is alive; its agent is named", () => {
    host("nelson-claude", process.pid);
    assert.equal(liveHostAgent(loop("on-host", { host_agent: "nelson-claude" }), home), "nelson-claude");
});

test("a host that is gone, a tmux loop, or no plate: not alive on a host", () => {
    // A pid that no longer runs: a process that has exited.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    host("gone-claude", gone);
    assert.equal(liveHostAgent(loop("host-gone", { host_agent: "gone-claude" }), home), null);
    assert.equal(liveHostAgent(loop("tmux", { host_agent: null }), home), null);
    assert.equal(liveHostAgent(loop("no-plate", null), home), null);
    assert.equal(liveHostAgent(loop("no-host-file", { host_agent: "never-started" }), home), null);
});

test("a loop is alive in tmux or on the host: prune, start and list never take a host loop for dead", () => {
    host("kept-claude", process.pid);
    const onHost = loop("kept", { host_agent: "kept-claude" });
    assert.equal(loopAlive(onHost, () => false, home), true, "no tmux session, but its host runs");
    assert.equal(loopAlive(loop("in-tmux", { host_agent: null }), () => true, home), true);
    assert.equal(loopAlive(loop("gone", { host_agent: null }), () => false, home), false);
});

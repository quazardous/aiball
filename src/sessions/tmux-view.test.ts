/**
 * #3135 — an agent's loop in tmux, as its state gives it: present, local, with
 * the tmux session to reach it; nothing for a loop that is not running, runs
 * on a proxy node, or runs on the host. And `mode` belongs to an agent's loop.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = mkdtempSync("/tmp/aiball-3135-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.AIBALL_PRESENCE_GRACE_MS = "10";

const { upsertConsumer, setConsumerState, touchLastSeen } = await import("../db.js");
const { presenceConnect, presenceDisconnect } = await import("../live-presence.js");
const { tmuxSessionView } = await import("./registry.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/register.js");
after(() => rmSync(home, { recursive: true, force: true }));

function loopDir(name: string, cwd: string): void {
    const dir = join(home, "loops", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plate.json"), JSON.stringify({ cwd }));
}

test("a present local loop in tmux: its view names the tmux session", () => {
    upsertConsumer({ consumer_id: "tmuxed", kind: "agent" });
    setConsumerState("tmuxed", "idle", false, undefined, "/work/tmuxed", "p");
    loopDir("cl-p-abc123", "/work/tmuxed");
    assert.equal(tmuxSessionView("tmuxed"), null, "not running: nothing");
    presenceConnect("tmuxed");
    const v = tmuxSessionView("tmuxed");
    assert.equal(v?.host, "tmux");
    assert.equal(v?.cwd, "/work/tmuxed");
    assert.match(v?.tmux ?? "", /cl-p-abc123/);
    presenceDisconnect("tmuxed");
});

test("a loop relayed by a proxy node is not a local tmux session", () => {
    upsertConsumer({ consumer_id: "remote", kind: "agent" });
    setConsumerState("remote", "idle", false, undefined, "/work/remote", "p");
    loopDir("cl-p-remote", "/work/remote");
    touchLastSeen("remote", "node", "10.0.0.9");
    presenceConnect("remote");
    assert.equal(tmuxSessionView("remote"), null);
    presenceDisconnect("remote");
});

test("mode is an agent loop's: a named session refuses it", async () => {
    const m = getMethod("session.start")!;
    const caller = { kind: "human", consumer_id: "boss", transport: "uds", relayed: false } as never;
    await assert.rejects(Promise.resolve().then(() => m.run(caller, { name: "x", argv: ["cat"], cwd: home, mode: "tmux" } as never)),
        (e: { status: number }) => e.status === 400);
});

/**
 * #3340 — who is attached to a tmux loop: read from tmux by the loop, said to
 * the daemon (`consumer.push_clients`), shown in the agent's session view and
 * broadcast when it changes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refused, testCaller } from "../tests/lib.js";

const home = mkdtempSync(join(tmpdir(), "aiball-3340-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3340-tmux-");
delete process.env.TMUX;
const { tmuxClients, tmuxName } = await import("../claude-loop/state.js");
const { getMethod } = await import("../bus/methods.js");
await import("../bus/methods/loop-io.js");
const { onBroadcast } = await import("../ws.js");
const { upsertConsumer } = await import("../db.js");
const { tmuxClientsOf, resetTmuxClientsForTests } = await import("./tmux-clients.js");
const attached: ChildProcess[] = [];
after(() => {
    for (const c of attached) c.kill();
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    resetTmuxClientsForTests();
    rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

/** A client in control mode: it needs no terminal, and tmux lists it like any other. */
function attach(session: string, readonly: boolean): ChildProcess {
    const c = spawn("tmux", ["-C", "attach", ...(readonly ? ["-r"] : []), "-t", session], { stdio: ["pipe", "ignore", "ignore"] });
    attached.push(c);
    return c;
}

async function until(ok: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > deadline) assert.fail("timed out");
        await new Promise((r) => setTimeout(r, 50));
    }
}

test("tmux says how many clients a loop has, and how many have the controls", { skip: spawnSync("tmux", ["-V"]).status !== 0 ? "no tmux" : false }, async () => {
    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-3340"), "sleep 60"], { stdio: "ignore" });
    assert.deepEqual(tmuxClients("cl-3340"), { clients: 0, interactive: 0 });
    attach(tmuxName("cl-3340"), false);
    const ro = attach(tmuxName("cl-3340"), true);
    await until(() => tmuxClients("cl-3340")?.clients === 2);
    assert.deepEqual(tmuxClients("cl-3340"), { clients: 2, interactive: 1 });
    ro.kill();
    await until(() => tmuxClients("cl-3340")?.clients === 1);
    assert.deepEqual(tmuxClients("cl-3340"), { clients: 1, interactive: 1 });
    assert.equal(tmuxClients("cl-no-such-loop"), null, "no session: tmux cannot say");
});

test("the loop says its clients; a change is broadcast, a repeat is not; only for itself", async () => {
    upsertConsumer({ consumer_id: "tmux-3340", kind: "agent" });
    const push = getMethod("consumer.push_clients")!;
    const heard: unknown[] = [];
    const off = onBroadcast((ev) => { if (ev.type === "consumer_changed") heard.push(ev.data); });
    try {
        const me = testCaller("tmux-3340");
        push.run(me, { consumer_id: "tmux-3340", clients: 2, interactive: 1 });
        assert.deepEqual(tmuxClientsOf("tmux-3340"), { clients: 2, interactive: 1 });
        assert.equal(heard.length, 1);
        assert.equal((heard[0] as { consumer_id: string }).consumer_id, "tmux-3340");
        push.run(me, { consumer_id: "tmux-3340", clients: 2, interactive: 1 });
        assert.equal(heard.length, 1, "the same word twice is one event");
        assert.equal((await refused(() => push.run(me, { consumer_id: "someone-else", clients: 1, interactive: 1 }))).status, 403);
        assert.equal((await refused(() => push.run(me, { consumer_id: "tmux-3340", clients: 1, interactive: 2 }))).status, 400);
    } finally {
        off();
    }
});

/**
 * #3499 — loop.remove: a stopped loop is forgotten as `claude-loop rm` does
 * (its state dir goes, `loop.<name>.state` turns null); a running one is
 * refused; the project's folder and its session ids stay.
 */
import { test, after } from "node:test";
import { refused, testCaller, until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3499-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3499-tmux-");
delete process.env.TMUX;
mkdirSync(join(home, "loops"), { recursive: true });

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { callMethod } = await import("./methods.js");
const { upsertConsumer } = await import("../db.js");
const { tmuxName } = await import("../claude-loop/state.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const boss = testCaller("boss", { kind: "human" });
const sockPath = join(home, "bus.sock");
const uds = createServer(createApp());
const wss = attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    spawnSync("tmux", ["kill-server"], { stdio: "ignore" });
    rmSync(process.env.TMUX_TMPDIR!, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

const project = join(home, "proj");
mkdirSync(project);
writeFileSync(join(project, ".aiball-session_id"), JSON.stringify({ default: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agents: {} }));

function plate(name: string, fields: Record<string, unknown>): void {
    mkdirSync(join(home, "loops", name), { recursive: true });
    writeFileSync(join(home, "loops", name, "plate.json"), JSON.stringify({ name, cwd: project, ...fields }));
}

test("a running loop is refused; once stopped it is forgotten, and every client hears it go", async () => {
    const watcher = await BusClient.connect({ socket: sockPath, consumer: "boss" });
    clients.push(watcher);
    const heard: Array<{ subject: string; data: unknown }> = [];
    watcher.onNotification((m, p) => { if (m === "bus.event") heard.push(p as { subject: string; data: unknown }); });
    await watcher.call("bus.subscribe", { subject: "loop.*.state" });

    plate("cl-one", { agent: "one", created_at: "2026-10-03T10:00:00Z" });
    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-one"), "sleep 60"], { stdio: "ignore" });
    const busy = await refused(callMethod(boss, "loop.remove", { name: "cl-one" }));
    assert.deepEqual([busy.status, busy.code], [409, "CONFLICT"]);
    assert.ok(existsSync(join(home, "loops", "cl-one")), "nothing touched");

    spawnSync("tmux", ["kill-session", "-t", tmuxName("cl-one")], { stdio: "ignore" });
    assert.deepEqual(await callMethod(boss, "loop.remove", { agent: "one" }), { removed: "cl-one" });
    assert.ok(!existsSync(join(home, "loops", "cl-one")), "its state dir is gone");
    assert.ok(!(await callMethod(boss, "loop.list", {}) as Array<{ name: string }>).some((l) => l.name === "cl-one"));
    await until("its state turns null", () => heard.some((e) => e.subject === "loop.cl-one.state" && e.data === null));
    assert.ok(existsSync(project), "the project's folder stays");
    assert.match(readFileSync(join(project, ".aiball-session_id"), "utf8"), /aaaaaaaa/, "its session ids stay");
});

test("an unknown loop, a call from elsewhere, an agent: refused", async () => {
    assert.equal((await refused(callMethod(boss, "loop.remove", { name: "cl-nobody" }))).status, 404);
    assert.equal((await refused(callMethod(boss, "loop.remove", {}))).status, 400);
    plate("cl-two", { agent: "two" });
    assert.equal((await refused(callMethod(testCaller("boss", { kind: "human", transport: "tcp" }), "loop.remove", { name: "cl-two" }))).status, 403);
    assert.equal((await refused(callMethod(testCaller("worker"), "loop.remove", { name: "cl-two" }))).code, "MODERATOR_ONLY");
    assert.ok(existsSync(join(home, "loops", "cl-two")));
});

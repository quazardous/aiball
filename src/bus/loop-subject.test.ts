/**
 * #3357 — loop.<name>.state: a client hears a loop start, change and go
 * (null), without re-reading loop.list.
 */
import { test, after } from "node:test";
import { until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3357-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.CLAUDE_LOOP_STATE_ROOT = join(home, "loops");
process.env.TMUX_TMPDIR = mkdtempSync("/tmp/claude-3357-tmux-");
delete process.env.TMUX;
mkdirSync(join(home, "loops"), { recursive: true });

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { tmuxName } = await import("../claude-loop/state.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
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

function plate(name: string, fields: Record<string, unknown>): void {
    mkdirSync(join(home, "loops", name), { recursive: true });
    writeFileSync(join(home, "loops", name, "plate.json"), JSON.stringify({ name, cwd: `/w/${name}`, ...fields }));
}

type View = { name: string; running: boolean; superseded: boolean; agent: string | null } | null;

test("a loop that appears, runs, is superseded and is forgotten: each is an event with its view", async () => {
    const boss = await BusClient.connect({ socket: sockPath, consumer: "boss" });
    clients.push(boss);
    const heard: Array<{ subject: string; view: View }> = [];
    let subId = "";
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; subject: string; data: View };
        if (m === "bus.event" && e.subscription === subId) heard.push({ subject: e.subject, view: e.data });
    });
    const sub = await boss.call<{ id: string; value: Record<string, View> }>("bus.subscribe", { subject: "loop.*.state" });
    subId = sub.id;
    assert.deepEqual(sub.value, {});
    const of = (name: string) => heard.filter((h) => h.subject === `loop.${name}.state`).map((h) => h.view);

    plate("cl-one", { agent: "one", created_at: "2026-09-29T10:00:00Z" });
    await until("the new loop", () => of("cl-one").some((v) => v?.name === "cl-one" && v.running === false));

    spawnSync("tmux", ["new-session", "-d", "-s", tmuxName("cl-one"), "sleep 60"], { stdio: "ignore" });
    await until("it runs (the safety tick or an event)", () => of("cl-one").some((v) => v?.running === true), 35_000);

    plate("cl-one-new", { agent: "one", created_at: "2026-09-29T11:00:00Z" });
    spawnSync("tmux", ["kill-session", "-t", tmuxName("cl-one")], { stdio: "ignore" });
    await until("the old one superseded", () => of("cl-one").some((v) => v?.running === false && v.superseded === true), 35_000);

    rmSync(join(home, "loops", "cl-one"), { recursive: true, force: true });
    await until("forgotten: null", () => of("cl-one").at(-1) === null);
});

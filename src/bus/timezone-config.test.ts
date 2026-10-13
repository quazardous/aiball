/**
 * #3969 — `display.timezone`: the zone agents and the web UI read times in.
 * `config.get` says it, resolved; `config.set` takes auto, UTC or a known zone,
 * a project overrides the board, and an unknown zone is refused with what to
 * write instead.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3969-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "xdg");

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { BusClient } = await import("../bus-client.js");
const { createProject } = await import("../db/projects.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: "p-3969" });

const sockPath = join(home, "bus.sock");
const uds = createServer(createApp());
const wss = attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));
const boss = await BusClient.connect({ socket: sockPath, consumer: "boss" });
after(() => {
    boss.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    rmSync(home, { recursive: true, force: true });
});

type Cfg = { timezone: string; timezone_setting: string };

test("auto by default: the daemon machine's zone", async () => {
    const c = await boss.call("config.get", {}) as Cfg;
    assert.equal(c.timezone_setting, "auto");
    assert.equal(c.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("a zone set on the board, and a project's own beside it", async () => {
    await boss.call("config.set", { key: "display.timezone", value: "America/New_York" });
    await boss.call("config.set", { key: "display.timezone", value: "UTC", project: "p-3969" });
    assert.equal((await boss.call("config.get", {}) as Cfg).timezone, "America/New_York");
    assert.equal((await boss.call("config.get", { project: "p-3969" }) as Cfg).timezone, "UTC");
    assert.equal((await boss.call("config.get", { project: "elsewhere" }) as Cfg).timezone, "America/New_York");
});

test("an unknown zone is refused, saying what it takes", async () => {
    await assert.rejects(
        boss.call("config.set", { key: "display.timezone", value: "Mars/Base" }),
        (e: Error) => /invalid value for 'display\.timezone'.*auto, UTC, or a zone name such as Europe\/Paris/.test(e.message),
    );
    assert.equal((await boss.call("config.get", {}) as Cfg).timezone, "America/New_York", "the value before stays");
});

/**
 * #3137 — the managed config, for a client that edits it: every number has a
 * range its default sits in, `config.set` refuses outside it, every setting
 * says its group; and `config.changed` tells a screen left open that a value
 * moved (set, clear) or that the files were reloaded.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3137-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.XDG_CONFIG_HOME = join(home, "xdg");

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { BusClient } = await import("../bus-client.js");
const { CONFIG_SCHEMA } = await import("../config/schema.js");
const { reloadConfig } = await import("../config-reload.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });

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

async function until(what: string, ok: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

test("every number has a range its default sits in, a step and a unit; every setting a group", () => {
    for (const e of CONFIG_SCHEMA) {
        assert.match(e.group, /^[a-z_]+(\.[a-z_]+){0,2}$/, `${e.key}: a group, a path of one to three levels`);
        if (e.type !== "number") continue;
        assert.ok(e.min !== undefined && e.max !== undefined && e.step && e.unit, `${e.key}: range, step and unit`);
        assert.ok((e.default as number) >= e.min! && (e.default as number) <= e.max!, `${e.key}: its default within its range`);
    }
});

test("config.managed gives the range; config.set refuses outside it, with the range in details", async () => {
    const r = await boss.call<{ config: Array<{ key: string; group: string; min: number | null; max: number | null; unit: string | null }> }>("config.managed", {});
    const e = r.config.find((c) => c.key === "tickets.step_after_max_minutes")!;
    assert.deepEqual({ group: e.group, min: e.min, max: e.max, unit: e.unit }, { group: "tickets.steps", min: 1, max: 1440, unit: "minutes" });
    await assert.rejects(boss.call("config.set", { key: "tickets.step_after_max_minutes", value: 5000 }),
        (err: { status: number; code: string; details?: { max: number } }) => err.status === 400 && err.code === "CONFIG_OUT_OF_RANGE" && err.details?.max === 1440);
    const ok = await boss.call<{ value: number }>("config.set", { key: "tickets.step_after_max_minutes", value: 90 });
    assert.equal(ok.value, 90);
});

test("config.changed: a set, a clear, a reload", async () => {
    const heard: Array<Record<string, unknown>> = [];
    let sub = "";
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; data: Record<string, unknown> };
        if (m === "bus.event" && e.subscription === sub) heard.push(e.data);
    });
    sub = (await boss.call<{ id: string }>("bus.subscribe", { subject: "config.changed" })).id;
    await boss.call("config.set", { key: "tickets.step_hot_minutes", value: 45 });
    await until("the set", () => heard.some((e) => e.op === "set"));
    assert.deepEqual(heard.find((e) => e.op === "set"), { op: "set", key: "tickets.step_hot_minutes", project: null, value: 45, by: "boss" });
    await boss.call("config.clear", { key: "tickets.step_hot_minutes" });
    await until("the clear", () => heard.some((e) => e.op === "clear"));
    reloadConfig();
    await until("the reload", () => heard.some((e) => e.op === "reload"));
});

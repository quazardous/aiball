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
const { CONFIG_SCHEMA, groupOf } = await import("../config/schema.js");
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
        assert.match(groupOf(e.key), /^[a-z_]+(\.[a-z_]+){0,2}$/, `${e.key}: a section, a path of one to three levels`);
        if (e.type !== "number" && e.type !== "duration") continue;
        assert.ok(e.min !== undefined && e.max !== undefined && e.step && (e.type === "duration" || e.unit), `${e.key}: range, step, and a number's unit`);
        assert.ok((e.default as number) >= e.min! && (e.default as number) <= e.max!, `${e.key}: its default within its range`);
    }
});

test("config.managed gives the range; config.set refuses outside it, with the range in details", async () => {
    const r = await boss.call<{ config: Array<{ key: string; group: string; min: number | null; max: number | null; unit: string | null }> }>("config.managed", {});
    const e = r.config.find((c) => c.key === "tickets.steps.max_wait")!;
    assert.deepEqual({ group: e.group, min: e.min, max: e.max, unit: e.unit }, { group: "tickets.steps", min: 60, max: 86400, unit: null });
    await assert.rejects(boss.call("config.set", { key: "tickets.steps.max_wait", value: "2d" }),
        (err: { status: number; code: string; details?: { max: number }; message: string }) =>
            err.status === 400 && err.code === "CONFIG_OUT_OF_RANGE" && err.details?.max === 86400 && /1m to 1d/.test(err.message));
    // #3138 — a duration takes the notation or seconds.
    assert.equal((await boss.call<{ value: number }>("config.set", { key: "tickets.steps.max_wait", value: "1h30m" })).value, 5400);
    assert.equal((await boss.call<{ value: number }>("config.set", { key: "tickets.steps.max_wait", value: 600 })).value, 600);
    await assert.rejects(boss.call("config.set", { key: "tickets.steps.max_wait", value: "30m1h" }), (err: { status: number }) => err.status === 400);
    // An old name, for one version: its unit converted, the key it means said.
    const legacy = await boss.call<{ key: string; value: number; renamed_from: string }>("config.set", { key: "tickets.step_after_max_minutes", value: 90 });
    assert.deepEqual(legacy, { key: "tickets.steps.max_wait", project: null, value: 5400, renamed_from: "tickets.step_after_max_minutes" });
});

test("config.changed: a set, a clear, a reload", async () => {
    const heard: Array<Record<string, unknown>> = [];
    let sub = "";
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; data: Record<string, unknown> };
        if (m === "bus.event" && e.subscription === sub) heard.push(e.data);
    });
    sub = (await boss.call<{ id: string }>("bus.subscribe", { subject: "config.changed" })).id;
    await boss.call("config.set", { key: "tickets.steps.hot", value: "45m" });
    await until("the set", () => heard.some((e) => e.op === "set"));
    assert.deepEqual(heard.find((e) => e.op === "set"), { op: "set", key: "tickets.steps.hot", project: null, value: 2700, by: "boss" });
    await boss.call("config.clear", { key: "tickets.steps.hot" });
    await until("the clear", () => heard.some((e) => e.op === "clear"));
    reloadConfig();
    await until("the reload", () => heard.some((e) => e.op === "reload"));
});

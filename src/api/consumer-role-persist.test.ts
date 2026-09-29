/**
 * #1435 slice 5 / #3312 — an agent's standing (its multi-agent role, its claim
 * right) is written by the agent's own loop, when it opens its events
 * (`agent.<id>.events`): no longer by any request that names the agent. A
 * second loop under the same agent from another machine is refused, so it
 * cannot take the first one's name, nor its standing. Through the real bus: a
 * connection on the local socket (machine `local`) and one with a token over
 * TCP (machine `tcp:127.0.0.1`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const home = mkdtempSync(join(tmpdir(), "aiball-3312-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.AIBALL_PRESENCE_GRACE_MS = "50";

const { createApp } = await import("../app.js");
const { attachBus } = await import("../bus/server.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getConsumer } = await import("../db.js");
const { BusClient } = await import("../bus-client.js");
const { initFolder } = await import("../project-init.js");

upsertConsumer({ consumer_id: "worker", kind: "agent" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "worker", label: "3312" }).token;

const tcp = createServer(createApp());
attachBus(tcp);
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const URL = `http://127.0.0.1:${(tcp.address() as AddressInfo).port}`;
const SOCK = join(home, "bus.sock");
const uds = createServer(createApp());
attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));
const clients: { close(): void }[] = [];
after(() => {
    for (const c of clients) c.close();
    for (const s of [tcp, uds]) { s.closeAllConnections(); s.close(); }
    rmSync(home, { recursive: true, force: true });
});

async function local(headers: Record<string, string> = {}) {
    const c = await BusClient.connect({ socket: SOCK, consumer: "worker", headers });
    clients.push(c);
    return c;
}
async function remote(headers: Record<string, string> = {}) {
    const c = await BusClient.connect({ url: URL, token: TOKEN, headers });
    clients.push(c);
    return c;
}
const events = (c: { call(m: string, p?: unknown): Promise<unknown> }) => c.call("bus.subscribe", { subject: "agent.worker.events" });

test("a request that names the agent no longer writes its row: neither the claim right nor the role", async () => {
    const c = await remote({ "x-aiball-no-claim": "1", "x-aiball-role": "crew" });
    await c.call("bus.whoami");
    assert.equal(getConsumer("worker")?.can_claim, true);
    assert.equal(getConsumer("worker")?.role, null);
    c.close();
});

test("the agent's own loop writes it, when it opens its events", async () => {
    const loop = await local({ "x-aiball-role": "crew" });
    await events(loop);
    assert.equal(getConsumer("worker")?.role, "crew");
    assert.equal(getConsumer("worker")?.can_claim, true, "no no-claim declared: the right stays");
    loop.close();
    await new Promise((r) => setTimeout(r, 150));
});

test("a second loop under the same agent from another machine is refused, and changes nothing", async () => {
    const first = await local();
    await events(first);
    const second = await remote({ "x-aiball-no-claim": "1" });
    await assert.rejects(events(second), (e: { code: string; message: string }) => e.code === "CONFLICT" && /runs already on local/.test(e.message));
    assert.equal(getConsumer("worker")?.can_claim, true, "the satellite did not take the claim right");
    // A second connection from the same machine (a reconnect overlap) is not a second loop.
    const again = await local();
    await events(again);
    for (const c of [first, second, again]) c.close();
    await new Promise((r) => setTimeout(r, 150));
});

test("once the first loop is gone, a loop from another machine takes the agent, and states its standing", async () => {
    const loop = await remote({ "x-aiball-no-claim": "1" });
    await events(loop);
    assert.equal(getConsumer("worker")?.can_claim, false, "its own loop declares no-claim");
    loop.close();
});

test("a crew set up without a name of its own is not given the lead's", async () => {
    const dir = mkdtempSync(join(home, "shop-"));
    initFolder({ cwd: dir, project: "shop", role: "crew" });
    const yaml = (await import("node:fs")).readFileSync(join(dir, ".aiball.yaml"), "utf8");
    assert.match(yaml, /agent: shop-crew/);
});

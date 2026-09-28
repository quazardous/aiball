/**
 * #3128 — an agent's screen on the bus (`agent.<id>.screen`), on a real session
 * host running `cat`: the snapshot, then the output; keys only through a
 * screen opened with typing; the size once the viewer typed; nothing left
 * attached after it lets go. And who may: a human, not an agent. The host part
 * needs it built (cargo); skipped, and says so, without it.
 */
import { test, after } from "node:test";
import { until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { sessionHostSkip } from "../tests/session-host-bin.js";

const home = mkdtempSync("/tmp/aiball-3128-");
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
const skip = sessionHostSkip();

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer } = await import("../db.js");
const { BusClient } = await import("../bus-client.js");
const { forgetSessionsForTests, sessionFor, startSession, stopSession } = await import("../sessions/registry.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "hosted", kind: "agent" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });

const sockPath = join(home, "bus.sock");
const uds = createServer(createApp());
const wss = attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(sockPath, () => r()));

const clients: { close(): void }[] = [];
async function as(consumer: string) {
    const c = await BusClient.connect({ socket: sockPath, consumer });
    clients.push(c);
    return c;
}
after(async () => {
    const link = sessionFor({ agent: "hosted" });
    if (link) await stopSession(link).catch(() => {});
    forgetSessionsForTests();
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    rmSync(home, { recursive: true, force: true });
});

type ScreenEvent = { kind: string; data?: string; rows?: number; cols?: number; size?: { rows: number; cols: number } | null; error?: string };

/** Every event each client heard, by subscription: one may land before its subscribe's answer is read. */
const heard = new Map<string, ScreenEvent[]>();
const listening = new WeakSet<object>();

/** Subscribe to a screen and collect its events. */
async function watch(c: Awaited<ReturnType<typeof as>>, agent: string, opts: Record<string, unknown> = {}) {
    if (!listening.has(c)) {
        listening.add(c);
        c.onNotification((method, params) => {
            const p = params as { subscription: string; data: ScreenEvent };
            if (method !== "bus.event") return;
            if (!heard.has(p.subscription)) heard.set(p.subscription, []);
            heard.get(p.subscription)!.push(p.data);
        });
    }
    const r = await c.call<{ id: string; value: unknown }>("bus.subscribe", { subject: `agent.${agent}.screen`, ...opts });
    if (!heard.has(r.id)) heard.set(r.id, []);
    const events = heard.get(r.id)!;
    const text = () => events.filter((e) => e.kind === "snapshot" || e.kind === "output").map((e) => Buffer.from(e.data!, "base64").toString("utf8")).join("");
    return { id: r.id, value: r.value, events, text };
}

test("an agent's screen is a human's view: an agent is refused, its keys too", async () => {
    const worker = await as("worker");
    await assert.rejects(worker.call("bus.subscribe", { subject: "agent.hosted.screen" }), (e: { status: number }) => e.status === 403);
    await assert.rejects(worker.call("agent.pane_keys", { agent: "hosted", keys: "x" }), (e: { status: number }) => e.status === 403);
});

test("an agent with no loop: no source, and one unavailable event saying why", async () => {
    const boss = await as("boss");
    const s = await watch(boss, "worker");
    assert.equal(s.value, null);
    await until("the unavailable event", () => s.events.length > 0);
    assert.equal(s.events[0]!.kind, "unavailable");
    assert.match(s.events[0]!.error!, /no loop running|no claude-loop/);
});

test("on the session host: the snapshot, keys through a typing screen, the size once it typed, nothing left attached", { skip }, async () => {
    const link = await startSession({ agent: "hosted", argv: ["cat"], cwd: home, size: { rows: 24, cols: 80 }, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    await until("the host running", () => link.running);
    const clientsNow = async () => ((await link.call("host.hello")) as { clients: number }).clients;
    const boss = await as("boss");

    // Watching: read-only, the snapshot first.
    const view = await watch(boss, "hosted");
    assert.deepEqual(view.value, { source: "host" });
    await until("the snapshot", () => view.events.some((e) => e.kind === "snapshot"));
    assert.deepEqual(view.events.find((e) => e.kind === "snapshot")!.size, { rows: 24, cols: 80 });
    await assert.rejects(boss.call("agent.pane_keys", { agent: "hosted", keys: "x" }), (e: { status: number; code: string }) => e.status === 409,
        "a watching screen does not type");

    // Typing: the keys reach cat, and its echo comes back as output.
    const typing = await watch(boss, "hosted", { typing: true, size: { rows: 30, cols: 100 } });
    await until("the typing screen's snapshot", () => typing.events.some((e) => e.kind === "snapshot"));
    await boss.call("agent.pane_keys", { agent: "hosted", keys: "typed from the web\r" });
    await until("the keys echoed", () => typing.text().includes("typed from the web"));
    await until("the watcher sees them too", () => view.text().includes("typed from the web"));

    // It typed: it owns the size, and every viewer hears the change.
    await until("the size it asked for", () => view.events.some((e) => e.kind === "size" && e.rows === 30 && e.cols === 100));
    await boss.call("agent.pane_resize", { agent: "hosted", rows: 40, cols: 120 });
    await until("the resize", async () => {
        const size = ((await link.call("host.hello")) as { size: { rows: number; cols: number } }).size;
        return size.rows === 40 && size.cols === 120;
    });

    // Letting go detaches from the host; the session carries on.
    assert.equal(await clientsNow(), 2);
    await boss.call("bus.unsubscribe", { id: view.id });
    await boss.call("bus.unsubscribe", { id: typing.id });
    await until("no client left", async () => (await clientsNow()) === 0);
    assert.equal(((await link.call("host.hello")) as { claude: { running: boolean } }).claude.running, true, "the session carries on");
});

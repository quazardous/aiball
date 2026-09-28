/**
 * #3133 — an agent's counters, the daemon's: computed on the events that move
 * them and pushed to its loop (`agent.<id>.events`) and to whoever watches it
 * (`agent.<id>.state`); on demand with `consumer.counters`. And the bar left by
 * a loop that comes back is live again, without waiting for a different push.
 */
import { test, after } from "node:test";
import { until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3133-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.AIBALL_COUNTERS_GAP_MS = "30";
process.env.AIBALL_PRESENCE_GRACE_MS = "20";

const { createTestApp: createApp } = await import("../tests/test-app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer, setConsumerState } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
createProject({ name: "counted" });
upsertSubscription("worker", "counted", "owner");
setConsumerState("worker", "idle", false, undefined, "/tmp/counted", "counted");

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
after(() => {
    for (const c of clients) c.close();
    for (const ws of wss.clients) ws.terminate();
    uds.closeAllConnections();
    uds.close();
    rmSync(home, { recursive: true, force: true });
});

type Counters = { open: number; actionable: number; backlog: number; events: number };

test("the loop gets its counters with the hello, then each change; a watcher gets them on the agent's state", async () => {
    const loop = await as("worker");
    const boss = await as("boss");
    const pushed: Counters[] = [];
    const states: Array<{ counters: Counters | null }> = [];
    let eventsSub = "";
    let stateSub = "";
    loop.onNotification((m, p) => {
        const e = p as { subscription: string; data: { event: string; data: Counters } };
        if (m === "bus.event" && e.subscription === eventsSub && e.data.event === "counters") pushed.push(e.data.data);
    });
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; data: { counters: Counters | null } };
        if (m === "bus.event" && e.subscription === stateSub) states.push(e.data);
    });
    const hello = await loop.call<{ id: string; value: { counters: Counters } }>("bus.subscribe", { subject: "agent.worker.events" });
    eventsSub = hello.id;
    assert.deepEqual({ ...hello.value.counters, computed_at: undefined }, { open: 0, actionable: 0, backlog: 0, events: 0, computed_at: undefined });
    stateSub = (await boss.call<{ id: string }>("bus.subscribe", { subject: "agent.worker.state" })).id;

    // A ticket filed on its project by a human: open, in its court, a ping.
    await boss.call("message.post", { kind: "ticket_created", project: "counted", title: "count me", body: "b" });
    await until("the pushed counters", () => pushed.some((c) => c.open === 1));
    const last = pushed.at(-1)!;
    assert.equal(last.open, 1);
    assert.ok(last.events >= 1, "the ping counts");
    await until("the state with them", () => states.some((s) => s.counters?.open === 1));

    // A ticket's lifecycle on its project has it computed again; one on
    // another project leaves it alone.
    const { cachedCounters } = await import("../agent-counters.js");
    const { emitLifecycle } = await import("../event-bus.js");
    const at = () => cachedCounters("worker")!.computed_at;
    await new Promise((r) => setTimeout(r, 60));
    const before = at();
    emitLifecycle({ op: "edited", message: { project: "elsewhere" } as never });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(at(), before, "another project's ticket is not its business");
    emitLifecycle({ op: "edited", message: { project: "counted" } as never });
    await until("computed again", () => at() !== before);

    // Nothing moved: an explicit ask computes, returns, and pushes nothing new.
    const pushedBefore = pushed.length;
    const asked = await boss.call<Counters>("consumer.counters", { consumer_id: "worker" });
    assert.equal(asked.open, 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(pushed.length, pushedBefore, "unchanged numbers are not pushed again");
});

test("consumer.counters: an agent reads its own, a human anyone's, another agent none", async () => {
    const other = await as("other");
    await assert.rejects(other.call("consumer.counters", { consumer_id: "worker" }), (e: { status: number }) => e.status === 403);
    // Without a project of its own, its loop counts across every project: the ticket above.
    const own = await other.call<Counters>("consumer.counters", { consumer_id: "other" });
    assert.equal(own.open, 1);
    const boss = await as("boss");
    await assert.rejects(boss.call("consumer.counters", { consumer_id: "boss" }), (e: { status: number }) => e.status === 400);
});

test("a loop that comes back: its bar is live again at once, not at its next different push", async () => {
    const { setAgentBar } = await import("../agent-bar-store.js");
    const { isPresent } = await import("../live-presence.js");
    const boss = await as("boss");
    const bars: Array<{ stale: boolean }> = [];
    let barSub = "";
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; data: { stale: boolean } };
        if (m === "bus.event" && e.subscription === barSub) bars.push(e.data);
    });
    // The loop is there and has a bar; then it goes: the bar goes stale.
    const loop = await as("other");
    const sub = await loop.call<{ id: string }>("bus.subscribe", { subject: "agent.other.events" });
    setAgentBar("other", { v: 1, state: "idle" } as never);
    barSub = (await boss.call<{ id: string }>("bus.subscribe", { subject: "agent.other.bar" })).id;
    await loop.call("bus.unsubscribe", { id: sub.id });
    await until("the loop gone", () => !isPresent("other"));
    await until("the bar stale", () => bars.at(-1)?.stale === true);
    // It comes back, and pushes nothing: the kept bar goes out again, live.
    const n = bars.length;
    await loop.call("bus.subscribe", { subject: "agent.other.events" });
    await until("the bar live again", () => bars.length > n && bars.at(-1)?.stale === false);
});

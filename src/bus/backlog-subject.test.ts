/**
 * #3356 — agent.<id>.backlog: a client watching an agent with no loop hears a
 * ticket sink (a backlog wake), come back (the rest ends) and come in.
 */
import { test, after } from "node:test";
import { until } from "../tests/lib.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3356-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { attachBus } = await import("./server.js");
const { upsertConsumer, setConsumerState } = await import("../db.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setAgentCooldown } = await import("../agent-cooldown.js");
const { BusClient } = await import("../bus-client.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "idle-lead", kind: "agent" });
setConsumerState("idle-lead", "idle", false, undefined, "/tmp/sinking", "sinking");
createProject({ name: "sinking" });
upsertSubscription("idle-lead", "sinking", "owner");
setAgentCooldown("idle-lead", 2);

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
    rmSync(home, { recursive: true, force: true });
});

type Backlog = { project: string | null; backlog: { id: number; tier: number | null; cooled_until: string | null }[] };

test("a wake sinks a ticket, its rest ends, a new ticket comes in: each is an event naming it", async () => {
    const boss = await BusClient.connect({ socket: sockPath, consumer: "boss" });
    clients.push(boss);
    const t1 = await boss.call<{ id: number }>("message.post", { kind: "ticket_created", project: "sinking", title: "one", body: "b" });
    const heard: number[][] = [];
    let subId = "";
    boss.onNotification((m, p) => {
        const e = p as { subscription: string; data: { changed: number[] } };
        if (m === "bus.event" && e.subscription === subId) heard.push(e.data.changed);
    });
    const sub = await boss.call<{ id: string; value: Backlog }>("bus.subscribe", { subject: "agent.idle-lead.backlog" });
    subId = sub.id;
    assert.equal(sub.value.project, "sinking");
    assert.deepEqual(sub.value.backlog.map((r) => [r.id, r.cooled_until]), [[t1.id, null]]);

    // No loop for idle-lead: its wake is recorded by hand, as a client would.
    await boss.call("backlog.record_wake", { consumer_id: "idle-lead", ticket_id: t1.id });
    await until("the wake heard", () => heard.some((c) => c.includes(t1.id)));
    await until("the rest's end heard", () => heard.filter((c) => c.includes(t1.id)).length >= 2, 6000);

    const t2 = await boss.call<{ id: number }>("message.post", { kind: "ticket_created", project: "sinking", title: "two", body: "b" });
    await until("the new ticket heard", () => heard.some((c) => c.includes(t2.id)), 5000);
});

/**
 * #3321 — the backlog rest a loop applies (`CL_BACKLOG_COOLDOWN_SEC`) is said
 * when it opens its events; `consumer.backlog` without `cooldown_sec`, and the
 * counters, apply it — instead of an hour assumed for every loop.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const home = mkdtempSync(join(tmpdir(), "aiball-3321-"));
process.env.AIBALL_HOME = home;
process.env.AIBALL_SOCK = "";
process.env.AIBALL_PRESENCE_GRACE_MS = "50";

const { createApp } = await import("./app.js");
const { attachBus } = await import("./bus/server.js");
const { upsertConsumer } = await import("./db.js");
const { createProject } = await import("./db/projects.js");
const { upsertSubscription } = await import("./db/subscriptions.js");
const { submitMessage } = await import("./messages.js");
const { BusClient } = await import("./bus-client.js");
const { computeCounters } = await import("./agent-counters.js");

upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "rest-agent", kind: "agent", project: "p-3321" } as never);
createProject({ name: "p-3321" });
upsertSubscription("rest-agent", "p-3321", "owner");
const ticket = submitMessage({ project: "p-3321", kind: "ticket_created", title: "resting", body: "b", by_agent: "boss" }).id;

const SOCK = join(home, "bus.sock");
const uds = createServer(createApp());
attachBus(uds, { trusted: true });
await new Promise<void>((r) => uds.listen(SOCK, () => r()));
const clients: { close(): void }[] = [];
after(() => { for (const c of clients) c.close(); uds.closeAllConnections(); uds.close(); rmSync(home, { recursive: true, force: true }); });

async function as(consumer: string) {
    const c = await BusClient.connect({ socket: SOCK, consumer });
    clients.push(c);
    return c;
}
const restOf = async (boss: { call<T>(m: string, p?: unknown): Promise<T> }) => {
    const r = await boss.call<{ rows: { id: number; backlog_cooled_until: string | null }[] }>("consumer.backlog", { consumer_id: "rest-agent", project: "p-3321" });
    const until = r.rows.find((x) => x.id === ticket)?.backlog_cooled_until;
    return until ? (Date.parse(until) - Date.now()) / 1000 : null;
};

test("without a loop saying its rest, a woken ticket rests the default hour", async () => {
    const agent = await as("rest-agent");
    await agent.call("backlog.record_wake", { ticket_id: ticket });
    const boss = await as("boss");
    const rest = await restOf(boss);
    assert.ok(rest !== null && rest > 3500 && rest <= 3600, `about an hour: ${rest}`);
});

test("a loop that says 600 s: consumer.backlog applies it, and the counters count the ticket as resting", async () => {
    const loop = await as("rest-agent");
    await loop.call("bus.subscribe", { subject: "agent.rest-agent.events", backlog_cooldown_sec: 600 });
    await loop.call("backlog.record_wake", { ticket_id: ticket });
    const boss = await as("boss");
    const rest = await restOf(boss);
    assert.ok(rest !== null && rest > 500 && rest <= 600, `the loop's 600 s: ${rest}`);
    assert.equal(computeCounters("rest-agent").backlog, 0, "resting: out of b:");
    // An explicit cooldown_sec still wins.
    const r = await boss.call<{ rows: { id: number; backlog_cooled_until: string | null }[] }>("consumer.backlog", { consumer_id: "rest-agent", project: "p-3321", cooldown_sec: "60" });
    const explicit = (Date.parse(r.rows.find((x) => x.id === ticket)!.backlog_cooled_until!) - Date.now()) / 1000;
    assert.ok(explicit > 0 && explicit <= 60, `the asked 60 s: ${explicit}`);
});

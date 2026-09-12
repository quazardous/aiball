/**
 * #2377 — a blocked ticket must keep surfacing so it is not forgotten, but
 * nothing moves on it between two wakes: after a backlog wake it stays out of
 * the pool `tickets.blocked_cooldown_multiplier` times longer than any other
 * ticket (twice, by default). What must hold, over the real routes:
 * - a ticket gated by an open blocker is cooled for twice the cooldown, while a
 *   plain ticket woken in the same pass is cooled for exactly the cooldown;
 * - the multiplier is per project: at 1, a blocked ticket cools like the rest.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2377-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setConfigOverride } = await import("../db/config-overrides.js");
const { invalidateFlagsCache } = await import("../db/projects.js");
const schema = await import("../schema.js");
const { and, eq, inArray } = await import("drizzle-orm");

const COOLDOWN = 600;
const P = "p-2377";
const ONE = "p-2377-one";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2377-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2377-w" }).token;
for (const p of [P, ONE]) {
    createProject({ name: p });
    upsertSubscription("worker", p, "owner");
}
setConfigOverride(ONE, "tickets.blocked_cooldown_multiplier", 1);

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
function ticket(project: string, title: string): number {
    return submitMessage({ project, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function blockOn(project: string, waiting: number, blocker: number): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${waiting}/relations`, { target_ticket_id: blocker, kind: "depends_on" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}
async function wake(ticketId: number): Promise<void> {
    const r = await call(WORKER, "POST", "/api/backlog-wake", { consumer_id: "worker", ticket_id: ticketId });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
/** Seconds the ticket stays out of the wake pool from now (0 = a candidate). */
async function cooledFor(project: string, ticketId: number): Promise<number> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${project}&backlog=1&limit=500&cooldown_sec=${COOLDOWN}`);
    const rows = r.json as { id: number; backlog_tier: number | null; backlog_cooled_until: string | null }[];
    const row = rows.find((x) => x.id === ticketId);
    assert.ok(row, `#${ticketId} in the worker's backlog`);
    return row!.backlog_cooled_until ? Math.round((Date.parse(row!.backlog_cooled_until) - Date.now()) / 1000) : 0;
}
async function tierOf(project: string, ticketId: number): Promise<number | null> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${project}&backlog=1&limit=500&cooldown_sec=${COOLDOWN}`);
    const rows = r.json as { id: number; backlog_tier: number | null }[];
    return rows.find((x) => x.id === ticketId)?.backlog_tier ?? null;
}

/** Move these wakes back in time, with the thread still older than the wake. */
function backdateWake(ticketIds: number[], agoSec: number): void {
    const wakeAt = new Date(Date.now() - agoSec * 1000).toISOString();
    getDb().update(schema.backlogWakeLog)
        .set({ wakeAt })
        .where(and(eq(schema.backlogWakeLog.consumerId, "worker"), inArray(schema.backlogWakeLog.ticketId, ticketIds)))
        .run();
    // The sink only holds a ticket whose thread has NOT moved since the wake;
    // moving the wake alone would read as "someone spoke after it".
    getDb().update(schema.tickets)
        .set({ lastActorAt: new Date(Date.now() - (agoSec + 60) * 1000).toISOString() })
        .where(inArray(schema.tickets.id, ticketIds))
        .run();
    // This write skips the routes, so it skips the flags cache repair too.
    invalidateFlagsCache();
}

test("a blocked ticket is cooled for twice the cooldown; a plain one for exactly the cooldown", async () => {
    const blocker = ticket(P, "the blocker, still open");
    const waiting = ticket(P, "waits on the blocker");
    const plain = ticket(P, "nothing gates this one");
    await blockOn(P, waiting, blocker);
    assert.equal(await tierOf(P, waiting), 4, "precondition: the waiting ticket is blocked");

    await wake(waiting);
    await wake(plain);

    const blockedFor = await cooledFor(P, waiting);
    const plainFor = await cooledFor(P, plain);
    assert.ok(blockedFor > COOLDOWN && blockedFor <= COOLDOWN * 2, `blocked cooled for ${blockedFor}s, expected about twice ${COOLDOWN}`);
    assert.ok(plainFor > 0 && plainFor <= COOLDOWN, `plain cooled for ${plainFor}s, expected the plain cooldown`);
});

test("past one cooldown the blocked ticket is still held, while the plain one is a candidate again", async () => {
    // The case the simulator caught: the query that reads recent wakes must look
    // back as far as the LONGEST hold, or a blocked ticket's wake drops out of
    // the window after one plain cooldown and the doubling never happens.
    const blocker = ticket(P, "blocker, for a wake moved back in time");
    const waiting = ticket(P, "blocked, woken a while ago");
    const plain = ticket(P, "plain, woken a while ago");
    await blockOn(P, waiting, blocker);
    await wake(waiting);
    await wake(plain);
    backdateWake([waiting, plain], COOLDOWN + 60);

    assert.ok(await cooledFor(P, waiting) > 0, "the blocked ticket is still held");
    assert.equal(await cooledFor(P, plain), 0, "the plain ticket is a candidate again");
});

test("the multiplier is per project: at 1, a blocked ticket cools like the rest", async () => {
    const blocker = ticket(ONE, "the blocker, still open");
    const waiting = ticket(ONE, "waits on the blocker");
    await blockOn(ONE, waiting, blocker);
    assert.equal(await tierOf(ONE, waiting), 4);

    await wake(waiting);

    const blockedFor = await cooledFor(ONE, waiting);
    assert.ok(blockedFor > 0 && blockedFor <= COOLDOWN, `cooled for ${blockedFor}s, expected the plain cooldown`);
});

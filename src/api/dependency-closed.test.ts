/**
 * #2297 step 1 — when a ticket closes, the tickets that were waiting on it hear
 * about it. Before, a `depends_on` gate lifted in silence: the dependent only
 * came back at the next backlog pass, if at all.
 * What must hold, over the real routes:
 * - closing T posts one `dependency_closed` event on each OPEN ticket waiting on
 *   it, whether the link was written `A depends_on T` or `T blocks A`; its owner
 *   gets it as an unread event, and it says which ticket closed;
 * - the event does not change whose turn it is (last actor unchanged);
 * - no relation, a removed relation, or a dependent already closed: nothing;
 * - a ticket closed again after a reopen notifies again.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2297-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2297-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2297-w" }).token;
createProject({ name: "p-2297" });
upsertSubscription("worker", "p-2297", "owner");

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

function ticket(title: string): number {
    return submitMessage({ project: "p-2297", kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
function lifecycle(kind: "ticket_closed" | "ticket_reopened", id: number): void {
    const m = submitMessage({ project: "p-2297", kind, ticket_id: id, by_agent: "boss" });
    assert.equal(m.status, "approved");
}
async function relate(source: number, target: number, kind: string): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${source}/relations`, { target_ticket_id: target, kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}
function dependencyEvents(onTicket: number): { source: number | null; body: string | null }[] {
    return getDb().select({ source: schema.messages.sourceTicketId, body: schema.messages.body })
        .from(schema.messages)
        .where(and(eq(schema.messages.ticketId, onTicket), eq(schema.messages.kind, "dependency_closed")))
        .all();
}
async function workerUnreadKinds(onTicket: number): Promise<string[]> {
    const r = await call(WORKER, "GET", "/api/unread?consumer_id=worker&limit=500");
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { kind: string; ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === onTicket).map((m) => m.kind);
}
function lastActor(id: number): string | null {
    return getDb().select({ a: schema.tickets.lastActor }).from(schema.tickets).where(eq(schema.tickets.id, id)).get()?.a ?? null;
}

test("closing a ticket tells the ticket that depends on it, which ticket closed", async () => {
    const blocker = ticket("the blocker");
    const waiting = ticket("waits on the blocker");
    await relate(waiting, blocker, "depends_on");
    const actorBefore = lastActor(waiting);

    lifecycle("ticket_closed", blocker);

    const events = dependencyEvents(waiting);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.source, blocker);
    assert.match(events[0]!.body ?? "", new RegExp(`#${blocker} closed`));
    assert.ok((await workerUnreadKinds(waiting)).includes("dependency_closed"), "the dependent's owner is woken");
    assert.equal(lastActor(waiting), actorBefore, "whose turn it is does not move");
});

test("a link written from the blocker's side (T blocks A) wakes A the same way", async () => {
    const blocker = ticket("blocks another");
    const waiting = ticket("blocked from the other side");
    await relate(blocker, waiting, "blocks");
    lifecycle("ticket_closed", blocker);
    assert.equal(dependencyEvents(waiting).length, 1);
});

test("no relation, a removed relation, or a dependent already closed: no event", async () => {
    const lone = ticket("closes alone");
    const unrelated = ticket("never linked");
    lifecycle("ticket_closed", lone);
    assert.equal(dependencyEvents(unrelated).length, 0);

    const blocker = ticket("link removed before close");
    const waiting = ticket("was waiting, then unlinked");
    await relate(waiting, blocker, "depends_on");
    await relate(waiting, blocker, "ignored");
    lifecycle("ticket_closed", blocker);
    assert.equal(dependencyEvents(waiting).length, 0, "a removed relation wakes nobody");

    const blocker2 = ticket("closes after its dependent");
    const done = ticket("dependent already closed");
    await relate(done, blocker2, "depends_on");
    lifecycle("ticket_closed", done);
    lifecycle("ticket_closed", blocker2);
    assert.equal(dependencyEvents(done).length, 0, "a closed ticket is not waiting any more");
});

test("closed again after a reopen, the blocker notifies again", async () => {
    const blocker = ticket("closes twice");
    const waiting = ticket("hears it twice");
    await relate(waiting, blocker, "depends_on");
    lifecycle("ticket_closed", blocker);
    lifecycle("ticket_reopened", blocker);
    lifecycle("ticket_closed", blocker);
    assert.equal(dependencyEvents(waiting).length, 2);
});

/**
 * #2378 — closing a ticket tells the tickets it is LINKED to, not only the ones
 * it was blocking. A ticket that was waiting on it keeps its `dependency_closed`
 * (its gate lifted); a ticket merely linked — lineage or a cross-reference —
 * gets `related_closed`: nothing changes for it, but the close is news it would
 * otherwise never hear. What must hold, over the real routes:
 * - `relates_to` and lineage (`child_of` / `parent_of`) get `related_closed`;
 * - a ticket both blocked by and linked to it hears once, the stronger one;
 * - `duplicates`, a ticket already closed, and the ticket the closed one itself
 *   depended on, hear nothing;
 * - the event does not change whose turn it is.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2378-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

const P = "p-2378";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2378-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2378-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

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
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
function close(id: number): void {
    assert.equal(submitMessage({ project: P, kind: "ticket_closed", ticket_id: id, by_agent: "boss" }).status, "approved");
}
async function relate(source: number, target: number, kind: string): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${source}/relations`, { target_ticket_id: target, kind });
    assert.equal(r.status, 200, JSON.stringify(r.json));
}
function eventsOfKinds(onTicket: number): string[] {
    return getDb().select({ kind: schema.messages.kind })
        .from(schema.messages)
        .where(eq(schema.messages.ticketId, onTicket))
        .all()
        .map((r) => r.kind)
        .filter((k) => k === "dependency_closed" || k === "related_closed");
}
function lastActor(id: number): string | null {
    return getDb().select({ a: schema.tickets.lastActor }).from(schema.tickets).where(eq(schema.tickets.id, id)).get()?.a ?? null;
}
async function workerUnreadKinds(onTicket: number): Promise<string[]> {
    const r = await call(WORKER, "GET", "/api/unread?consumer_id=worker&limit=500");
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { kind: string; ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === onTicket).map((m) => m.kind);
}

test("a merely linked ticket hears the close as related_closed, and its turn does not move", async () => {
    const closing = ticket("closes, and is linked");
    const xref = ticket("linked by a cross-reference");
    const child = ticket("a child of the closing ticket");
    await relate(xref, closing, "relates_to");
    await relate(child, closing, "child_of");
    const actorBefore = lastActor(xref);

    close(closing);

    assert.deepEqual(eventsOfKinds(xref), ["related_closed"]);
    assert.deepEqual(eventsOfKinds(child), ["related_closed"]);
    assert.equal(lastActor(xref), actorBefore, "whose turn it is does not move");
    assert.ok((await workerUnreadKinds(xref)).includes("related_closed"), "the project's owner hears it");
});

test("a ticket both blocked by and linked to the closed one hears once, the stronger one", async () => {
    const closing = ticket("blocks and is linked to the same ticket");
    const both = ticket("waits on it AND is linked to it");
    await relate(both, closing, "depends_on");
    await relate(both, closing, "relates_to");

    close(closing);

    assert.deepEqual(eventsOfKinds(both), ["dependency_closed"], "one event, the gate one");
});

test("a duplicate, an already closed ticket, and the one the closed ticket waited on hear nothing", async () => {
    const closing = ticket("closes with a duplicate and a blocker of its own");
    const duplicate = ticket("duplicates the closing ticket");
    const alreadyClosed = ticket("linked but already closed");
    const itsOwnBlocker = ticket("the closing ticket was waiting on this one");
    await relate(duplicate, closing, "duplicates");
    await relate(alreadyClosed, closing, "relates_to");
    await relate(closing, itsOwnBlocker, "depends_on");
    close(alreadyClosed);

    close(closing);

    assert.deepEqual(eventsOfKinds(duplicate), [], "a duplicate's close is its own story");
    assert.deepEqual(eventsOfKinds(alreadyClosed), [], "a closed ticket is told nothing");
    assert.deepEqual(eventsOfKinds(itsOwnBlocker), [], "closing a waiting ticket frees nobody");
});

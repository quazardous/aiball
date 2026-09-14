/**
 * #2458 — a backlog row says when THIS consumer's wake last named the ticket
 * (`backlog_last_wake_at`), so the loop can tell a ticket coming back too soon.
 * The wake log is per consumer: another agent's wake on the same ticket must
 * neither show up there nor move this consumer's cooldown end — the read used
 * to take every consumer's rows.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2458-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject, recordBacklogWake } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

const COOLDOWN = 3600;
const P = "p-2458";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
// Sorts after "worker": with the unscoped read, its row came last and won.
upsertConsumer({ consumer_id: "zed", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2458-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("zed", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Row = { id: number; backlog_cooled_until: string | null; backlog_last_wake_at: string | null };
async function row(ticketId: number): Promise<Row> {
    const r = await fetch(`${BASE}/api/tickets?project=${P}&backlog=1&limit=500&cooldown_sec=${COOLDOWN}`, {
        headers: { authorization: `Bearer ${WORKER}` },
    });
    const found = ((await r.json()) as Row[]).find((x) => x.id === ticketId);
    assert.ok(found, `#${ticketId} in the worker's backlog`);
    return found;
}
function backdateWake(consumer: string, ticketId: number, iso: string): void {
    getDb().update(schema.backlogWakeLog).set({ wakeAt: iso })
        .where(and(eq(schema.backlogWakeLog.consumerId, consumer), eq(schema.backlogWakeLog.ticketId, ticketId)))
        .run();
}

test("no wake yet: no last wake on the row", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "fresh", body: "x", by_agent: "boss" }).id;
    assert.equal((await row(t)).backlog_last_wake_at, null);
});

test("the row carries MY last wake, and another agent's later wake changes neither it nor my cooldown", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "woken twice", body: "x", by_agent: "boss" }).id;
    const mine = new Date(Date.now() - 20 * 60_000).toISOString();
    // The ticket was filed before my wake, so the wake still holds it sunk.
    getDb().update(schema.tickets).set({ lastActorAt: new Date(Date.now() - 30 * 60_000).toISOString() })
        .where(eq(schema.tickets.id, t)).run();
    recordBacklogWake("worker", t);
    backdateWake("worker", t, mine);
    recordBacklogWake("zed", t);

    const r = await row(t);
    assert.equal(r.backlog_last_wake_at, mine);
    assert.equal(r.backlog_cooled_until, new Date(Date.parse(mine) + COOLDOWN * 1000).toISOString());
});

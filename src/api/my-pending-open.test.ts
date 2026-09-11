/**
 * #2339 — the pending tickets poll lists are the ones it counts.
 * What must hold, over the real HTTP routes:
 * - a pending ticket that was closed leaves the list (with `open=1`) and the
 *   count; reopened, it comes back in both;
 * - the closed ones are dropped before the limit cuts the list, so a cut list
 *   is not short of an open ticket;
 * - without `open`, the listing is unchanged: closed pending tickets stay there.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2339-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const schema = await import("../schema.js");
const { eq } = await import("drizzle-orm");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2339-h" }).token;
createProject({ name: "p-2339" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function get<T>(path: string): Promise<T> {
    const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${HUMAN}` } });
    assert.equal(r.status, 200, path);
    return await r.json() as T;
}

/** A ticket by the agent, left waiting in moderation. */
function pendingTicket(title: string): number {
    const t = submitMessage({ project: "p-2339", kind: "ticket_created", title, body: "x", by_agent: "worker" });
    getDb().update(schema.tickets).set({ status: "pending" }).where(eq(schema.tickets.id, t.id)).run();
    return t.id;
}
function lifecycle(kind: "ticket_closed" | "ticket_reopened", ticketId: number): void {
    const m = submitMessage({ project: "p-2339", kind, ticket_id: ticketId, by_agent: "boss" });
    assert.equal(m.status, "approved", `${kind} by the moderator lands at once`);
}

const listed = async (query = "", open = true) =>
    (await get<{ id: number }[]>(`/api/messages?kind=ticket_created&status=pending&by_agent=worker${open ? "&open=1" : ""}${query}`))
        .map((m) => m.id);
const counted = async () => (await get<{ count: number }>("/api/my-pending/count?by_agent=worker")).count;

const kept = pendingTicket("stays open");
const dropped = pendingTicket("closed while pending");

test("a closed pending ticket leaves the list and the count, and comes back when reopened", async () => {
    assert.deepEqual(await listed(), [dropped, kept]);
    assert.equal(await counted(), 2);

    lifecycle("ticket_closed", dropped);
    assert.deepEqual(await listed(), [kept]);
    assert.equal(await counted(), 1, "the list says what the count says");

    lifecycle("ticket_reopened", dropped);
    assert.deepEqual(await listed(), [dropped, kept]);
    assert.equal(await counted(), 2);

    lifecycle("ticket_closed", dropped);
    assert.deepEqual(await listed(), [kept], "closed again");
});

test("the closed tickets go before the limit cuts the list", async () => {
    assert.deepEqual(await listed("&limit=1"), [kept], "the newest is closed, the open one still comes back");
});

test("without open, the listing still carries closed pending tickets", async () => {
    assert.deepEqual(await listed("", false), [dropped, kept]);
});

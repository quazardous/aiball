/**
 * #2759 — a sub-ticket an agent files can sit waiting for moderation: out of its
 * backlog and its counts, it looks inert, and a closed parent made it look closed
 * too (grampy #2730). Each surface that names such a ticket now says so plainly:
 * the wake's event feed, the parent's list of sub-tickets, and `ticket_list`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2759-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2759";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2759-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2759-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}

test("a sub-ticket waiting for moderation says so in the feed, the parent and the list", async () => {
    const parent = submitMessage({ project: P, kind: "ticket_created", title: "umbrella", body: "x", by_agent: "boss" }).id;
    const child = submitMessage({ project: P, kind: "ticket_created", title: "child", body: "x", by_agent: "worker" }).id;
    const approvedChild = submitMessage({ project: P, kind: "ticket_created", title: "approved child", body: "x", by_agent: "boss" }).id;
    for (const c of [child, approvedChild]) {
        const r = await call(HUMAN, "POST", `/api/tickets/${c}/relations`, { target_ticket_id: parent, kind: "child_of" });
        assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    // The agent's child is still in moderation; the human's is approved.
    assert.equal(getDb().select().from(schema.tickets).all().find((t) => t.id === child)?.status, "pending");

    // The parent closes: its cascade reaches both children.
    assert.equal(submitMessage({ project: P, kind: "ticket_closed", ticket_id: parent, by_agent: "boss" }).status, "approved");

    const feed = await call(WORKER, "GET", "/api/unread?consumer_id=worker&limit=50");
    const reached = (feed.json.messages as any[]).filter((m) => m.kind === "related_closed");
    const onChild = reached.find((m) => m.ticket_id === child);
    assert.ok(onChild, `the child heard its parent close: ${JSON.stringify(feed.json.messages.map((m: any) => [m.kind, m.ticket_id]))}`);
    assert.equal(onChild.ticket_awaiting_moderation, true, "the feed says the child waits for moderation");
    const onApproved = reached.find((m) => m.ticket_id === approvedChild);
    if (onApproved) assert.equal(onApproved.ticket_awaiting_moderation, undefined, "an approved ticket carries no such flag");

    const parentView = await call(HUMAN, "GET", `/api/tickets/${parent}`);
    const subs = (parentView.json.ticket?.sub_tickets ?? parentView.json.sub_tickets) as any[];
    assert.equal(subs.find((s) => s.id === child)?.awaiting_moderation, true, "the parent's list flags it");
    assert.equal(subs.find((s) => s.id === approvedChild)?.awaiting_moderation, false);

    // The default list shows approved tickets only; `status=any` widens it.
    const list = await call(HUMAN, "GET", `/api/tickets?project=${P}&status=any`);
    const row = (list.json as any[]).find((t) => t.id === child);
    assert.equal(row?.awaiting_moderation, true, "ticket_list flags it");
    assert.equal((list.json as any[]).find((t) => t.id === approvedChild)?.awaiting_moderation, false);
});

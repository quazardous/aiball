/**
 * #2180 — the pending-children sweep. A moderator approves a ticket's pending
 * `child_of` children in one gesture, after seeing who attached each one.
 *
 * What must hold: an agent cannot sweep; only the ids the moderator sent are
 * touched; an id that is not (or no longer) a pending child is refused rather
 * than approved; a child attached after the listing is not swept along; and
 * the listing stops at one level. Spawns the real app on an ephemeral port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2180-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { insertTypedRelation, updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");

getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2180-h" }).token;
const AGENT = issueToken({ kind: "agent", consumer_id: "worker", label: "2180-a" }).token;
createProject({ name: "p-2180" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface Child { ticket_id: number; attached_by: string | null; attached_at: string }
interface Sweep { approved: number[]; skipped: Array<{ ticket_id: number; reason: string }> }

/** A ticket forced to the given moderation status: the test is about the sweep,
 *  not about the rules that decide whether a fresh ticket starts pending. */
function ticket(title: string, status: "pending" | "approved", by = "worker"): number {
    const t = submitMessage({ project: "p-2180", kind: "ticket_created", title, body: "x", by_agent: by });
    if (t.status !== status) updateMessageStatus(t.id, status, "human", null, "ticket_created");
    return t.id;
}
function attach(child: number, parent: number, by: string | null): void {
    insertTypedRelation({ source_ticket_id: child, target_ticket_id: parent, relation_kind: "child_of", by_agent: by });
}
async function call<T>(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as T };
}
const statusOf = (id: number) => getMessage(id)?.status;
const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);

test("listing: pending children only, one level down, with who attached each", async () => {
    const parent = ticket("objective", "approved", "boss");
    const byAgent = ticket("attached by an agent", "pending");
    const byBoss = ticket("attached by the moderator", "pending");
    const approved = ticket("already approved", "approved");
    const grandchild = ticket("grandchild", "pending");
    attach(byAgent, parent, "worker");
    attach(byBoss, parent, "boss");
    attach(approved, parent, "worker");
    attach(grandchild, byAgent, "worker");

    const r = await call<{ children: Child[] }>(AGENT, "GET", `/tickets/${parent}/pending-children`);
    assert.equal(r.status, 200);
    assert.deepEqual(sorted(r.json.children.map((c) => c.ticket_id)), sorted([byAgent, byBoss]));
    const byId = new Map(r.json.children.map((c) => [c.ticket_id, c]));
    assert.equal(byId.get(byAgent)?.attached_by, "worker");
    assert.equal(byId.get(byBoss)?.attached_by, "boss");
    assert.ok(byId.get(byAgent)?.attached_at, "attachment time is reported");
});

test("an agent cannot sweep: 403, and the child stays pending", async () => {
    const parent = ticket("objective", "approved", "boss");
    const child = ticket("child", "pending");
    attach(child, parent, "worker");

    const r = await call<unknown>(AGENT, "POST", `/tickets/${parent}/approve-pending-children`, { ticket_ids: [child] });
    assert.equal(r.status, 403);
    assert.equal(statusOf(child), "pending");
});

test("a moderator approves exactly the children sent", async () => {
    const parent = ticket("objective", "approved", "boss");
    const a = ticket("a", "pending");
    const b = ticket("b", "pending");
    attach(a, parent, "worker");
    attach(b, parent, "boss");

    const r = await call<Sweep>(HUMAN, "POST", `/tickets/${parent}/approve-pending-children`, { ticket_ids: [a, b] });
    assert.equal(r.status, 200);
    assert.deepEqual(sorted(r.json.approved), sorted([a, b]));
    assert.deepEqual(r.json.skipped, []);
    assert.equal(statusOf(a), "approved");
    assert.equal(statusOf(b), "approved");
});

test("an id that is not a pending child is refused, never approved", async () => {
    const parent = ticket("objective", "approved", "boss");
    const child = ticket("child", "pending");
    const stranger = ticket("pending, but hung under nothing", "pending");
    const done = ticket("child, already approved", "approved");
    attach(child, parent, "worker");
    attach(done, parent, "worker");

    const r = await call<Sweep>(HUMAN, "POST", `/tickets/${parent}/approve-pending-children`, {
        ticket_ids: [child, stranger, done],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.approved, [child]);
    const skipped = new Map(r.json.skipped.map((s) => [s.ticket_id, s.reason]));
    assert.match(skipped.get(stranger) ?? "", /not a child/);
    assert.match(skipped.get(done) ?? "", /not pending/);
    assert.equal(statusOf(stranger), "pending", "an id smuggled into the list must not be approved");
});

test("a child attached after the listing is not swept along", async () => {
    const parent = ticket("objective", "approved", "boss");
    const early = ticket("listed", "pending");
    attach(early, parent, "worker");
    const listed = await call<{ children: Child[] }>(HUMAN, "GET", `/tickets/${parent}/pending-children`);
    const ids = listed.json.children.map((c) => c.ticket_id);

    const late = ticket("attached after the moderator looked", "pending");
    attach(late, parent, "worker");

    const r = await call<Sweep>(HUMAN, "POST", `/tickets/${parent}/approve-pending-children`, { ticket_ids: ids });
    assert.deepEqual(r.json.approved, [early]);
    assert.equal(statusOf(late), "pending");
});

test("no ids, no sweep: a missing or empty list is a 400, never approve-all", async () => {
    const parent = ticket("objective", "approved", "boss");
    const child = ticket("child", "pending");
    attach(child, parent, "worker");

    assert.equal((await call<unknown>(HUMAN, "POST", `/tickets/${parent}/approve-pending-children`, {})).status, 400);
    assert.equal((await call<unknown>(HUMAN, "POST", `/tickets/${parent}/approve-pending-children`, { ticket_ids: [] })).status, 400);
    assert.equal(statusOf(child), "pending");
});

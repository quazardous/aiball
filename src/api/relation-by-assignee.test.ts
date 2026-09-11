/**
 * #2368 — `then: wait` is gone; an agent says its ticket waits on another with a
 * `depends_on` relation. The agent a ticket is assigned to may not be its
 * reporter nor an owner of its project (a crew member following it), so the
 * relation route lets it set that gate. What must hold, over the real routes:
 * - the assignee of either ticket may relate them `depends_on` / `blocks`, and
 *   cut that gate again;
 * - it may not touch the other axes (lineage, cross-references), and an agent
 *   that neither holds, reported nor owns them may not relate them at all;
 * - while the other ticket is open the assignee's ticket is out of its
 *   actionable pool; its close brings it back with a `dependency_closed` event.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2368-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");

const P = "p-2368";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
upsertConsumer({ consumer_id: "crew", kind: "agent" });
upsertConsumer({ consumer_id: "bystander", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2368-h" }).token;
const CREW = issueToken({ kind: "agent", consumer_id: "crew", label: "2368-c" }).token;
const BYSTANDER = issueToken({ kind: "agent", consumer_id: "bystander", label: "2368-b" }).token;
createProject({ name: P });
upsertSubscription("lead", P, "owner");
upsertSubscription("crew", P, "follower");
upsertSubscription("bystander", P, "follower");

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
async function assignToCrew(id: number): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${id}/assign`, { assignee: "crew" });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
function relate(token: string, source: number, target: number, kind: string, axis_kind?: string) {
    return call(token, "POST", `/api/tickets/${source}/relations`, { target_ticket_id: target, kind, ...(axis_kind ? { axis_kind } : {}) });
}
async function crewActionable(id: number): Promise<boolean> {
    const r = await call(CREW, "GET", `/api/tickets?project=${P}&actionable=1&limit=500`);
    return (r.json as { id: number }[]).some((row) => row.id === id);
}
async function crewUnreadKinds(onTicket: number): Promise<string[]> {
    const r = await call(CREW, "GET", "/api/unread?consumer_id=crew&limit=500");
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { kind: string; ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === onTicket).map((m) => m.kind);
}

test("the assignee may set and cut the dependency gate, and nothing else; a bystander may not relate at all", async () => {
    const held = ticket("assigned to the crew");
    const other = ticket("the one it waits on");
    await assignToCrew(held);

    assert.equal((await relate(CREW, held, other, "depends_on")).status, 200, "the assignee sets the gate");
    assert.equal((await relate(CREW, held, other, "ignored", "depends_on")).status, 200, "and cuts it");
    assert.equal((await relate(CREW, other, held, "blocks")).status, 200, "from either side");

    assert.equal((await relate(CREW, held, other, "relates_to")).status, 403, "not a cross-reference");
    assert.equal((await relate(CREW, held, other, "child_of")).status, 403, "not lineage");
    assert.equal((await relate(CREW, held, other, "ignored")).status, 403, "not a cut of every axis");
    assert.equal((await relate(BYSTANDER, held, other, "depends_on")).status, 403, "an agent that does not hold it");
});

test("while the other ticket is open the assignee's ticket is blocked; its close brings it back with dependency_closed", async () => {
    const held = ticket("waits for the other");
    const other = ticket("still open");
    await assignToCrew(held);
    assert.equal(await crewActionable(held), true, "assigned, it is the crew's to act on");

    assert.equal((await relate(CREW, held, other, "depends_on")).status, 200);
    assert.equal(await crewActionable(held), false, "blocked while the other is open");

    const closed = submitMessage({ project: P, kind: "ticket_closed", ticket_id: other, by_agent: "boss" });
    assert.equal(closed.status, "approved");
    assert.equal(await crewActionable(held), true, "back once it closes");
    assert.ok((await crewUnreadKinds(held)).includes("dependency_closed"), "and the assignee hears about it");
});

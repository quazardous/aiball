/**
 * #2394 david — the ticket backlog is the PROJECT's work. What an agent is told
 * is actionable used to be computed board-wide with no role check: an agent
 * asking for its work got every project's tickets, none of them claimable.
 * What must hold, over the real routes:
 * - the project's lead (owner) keeps its project's tickets;
 * - an agent with no role there sees nothing of it — unless the ticket is
 *   ASSIGNED to it, which a follower and a no-claim agent keep too;
 * - a human keeps the whole board: moderating is the job;
 * - events are untouched — being told is not being asked (david).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2394-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const MINE = "p-2394-mine";
const THEIRS = "p-2394-theirs";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "lead", kind: "agent" });
upsertConsumer({ consumer_id: "neighbour", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2394-h" }).token;
const LEAD = issueToken({ kind: "agent", consumer_id: "lead", label: "2394-l" }).token;
const NEIGHBOUR = issueToken({ kind: "agent", consumer_id: "neighbour", label: "2394-n" }).token;
for (const p of [MINE, THEIRS]) createProject({ name: p });
upsertSubscription("lead", MINE, "owner");
upsertSubscription("neighbour", THEIRS, "owner");
// The neighbour follows the other project: it hears it, it does not work it.
upsertSubscription("neighbour", MINE, "follower");

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
async function actionableFor(token: string): Promise<number[]> {
    const r = await call(token, "GET", "/api/tickets?actionable=1&limit=500");
    return (r.json as { id: number }[]).map((t) => t.id);
}
async function assignTo(ticketId: number, consumer: string): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/tickets/${ticketId}/assign`, { assignee: consumer });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function approve(messageId: number): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/messages/${messageId}/approve`, {});
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function comment(token: string, ticketId: number): Promise<void> {
    const r = await call(token, "POST", "/api/messages", {
        project: (await call(HUMAN, "GET", `/api/tickets/${ticketId}`).then((x) => (x.json as { ticket: { project: string } }).ticket.project)),
        kind: "comment_added", ticket_id: ticketId, body: "a word", summary_until: "s", handback: true,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function unreadKinds(token: string, consumer: string, ticketId: number): Promise<string[]> {
    const r = await call(token, "GET", `/api/unread?consumer_id=${consumer}&limit=500`);
    const rows = (Array.isArray(r.json) ? r.json : (r.json as { messages?: unknown[] }).messages ?? []) as { kind: string; ticket_id: number | null }[];
    return rows.filter((m) => m.ticket_id === ticketId).map((m) => m.kind);
}

test("the project's lead keeps its work; an agent with no role there sees none of it", async () => {
    const mine = ticket(MINE, "work of the project I lead");

    assert.ok((await actionableFor(LEAD)).includes(mine), "the lead has it");
    assert.ok(!(await actionableFor(NEIGHBOUR)).includes(mine), "a follower does not read it as its work");
});

test("a ticket assigned to an agent is its work, whatever project it lives in", async () => {
    const mine = ticket(MINE, "assigned to the neighbour");

    await assignTo(mine, "neighbour");

    assert.ok((await actionableFor(NEIGHBOUR)).includes(mine), "the assignee has it");
});

test("a human keeps the whole board", async () => {
    const mine = ticket(MINE, "a ticket in one project");
    const theirs = ticket(THEIRS, "a ticket in the other");
    // The human is in nobody's court until an agent hands something back.
    await comment(LEAD, mine);
    await comment(NEIGHBOUR, theirs);

    const seen = await actionableFor(HUMAN);

    assert.ok(seen.includes(mine) && seen.includes(theirs), "moderating needs every project");
});

test("events are untouched: the agent that filed it elsewhere still hears it", async () => {
    // The neighbour files in a project it does not lead — the cross-project ask.
    const filed = submitMessage({ project: MINE, kind: "ticket_created", title: "asked of the other project", body: "x", by_agent: "neighbour" });
    await approve(filed.id);
    await comment(LEAD, filed.id);

    assert.ok(!(await actionableFor(NEIGHBOUR)).includes(filed.id), "not its work: it leads nothing here, and holds no assignment");
    assert.ok((await unreadKinds(NEIGHBOUR, "neighbour", filed.id)).includes("comment_added"), "but it is told — being told is not being asked");
});

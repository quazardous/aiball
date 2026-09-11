/**
 * #2373 — the project stats count a ticket as resolved when a resolution
 * accepted on a comment closed it. The resolved count replayed the lifecycle
 * rows only, and accepting a resolution on a comment writes no
 * `ticket_resolved` row, so nearly every resolved ticket was missed (84 of 822
 * on the live aiball board). What must hold, over the real routes (one project
 * per case, so counts are exact):
 * - a resolution accepted on a comment (which closes the ticket) counts as
 *   closed and resolved;
 * - a close without a resolution counts as closed, not resolved;
 * - reopened, then closed again with no new resolution: closed, not resolved.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2373-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2373-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2373-w" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
function project(name: string): string {
    createProject({ name });
    upsertSubscription("worker", name, "owner");
    return name;
}
function ticket(p: string, title: string): number {
    return submitMessage({ project: p, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
/** The worker proposes a resolution and the human accepts it, which closes the ticket. */
async function resolveOnComment(p: string, ticketId: number): Promise<void> {
    const r = await call(WORKER, "POST", "/api/messages", { project: p, kind: "comment_added", ticket_id: ticketId, body: "done", summary_until: "s", decision_kind: "resolution" });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    assert.ok((await call(HUMAN, "POST", `/api/messages/${r.json.id as number}/decide`, { status: "accepted" })).status < 300);
}
function lifecycle(p: string, kind: "ticket_closed" | "ticket_reopened", ticketId: number): void {
    assert.equal(submitMessage({ project: p, kind, ticket_id: ticketId, by_agent: "boss" }).status, "approved");
}
async function counts(p: string): Promise<{ closed: number; resolved: number }> {
    const r = await call(HUMAN, "GET", `/api/projects/${p}/stats-rich`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return { closed: r.json.closed_count as number, resolved: r.json.resolved_count as number };
}

test("a resolution accepted on a comment counts as closed and resolved", async () => {
    const p = project("p-2373-resolved");
    await resolveOnComment(p, ticket(p, "resolved on a comment"));
    assert.deepEqual(await counts(p), { closed: 1, resolved: 1 });
});

test("a close without a resolution counts as closed, not resolved", async () => {
    const p = project("p-2373-closed");
    lifecycle(p, "ticket_closed", ticket(p, "closed as is"));
    assert.deepEqual(await counts(p), { closed: 1, resolved: 0 });
});

test("reopened after a resolution, then closed again without one: closed, not resolved", async () => {
    const p = project("p-2373-reopened");
    const t = ticket(p, "resolved, reopened, closed");
    await resolveOnComment(p, t);
    lifecycle(p, "ticket_reopened", t);
    assert.deepEqual(await counts(p), { closed: 0, resolved: 0 }, "reopened");
    lifecycle(p, "ticket_closed", t);
    assert.deepEqual(await counts(p), { closed: 1, resolved: 0 }, "closed again with no new resolution");
});

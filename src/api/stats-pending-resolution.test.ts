/**
 * #2372 — the project stats' "pending resolution" counter counts what the list
 * badges: open, unsnoozed tickets whose latest decision is a proposed
 * resolution. It used to count only the old `ticket_resolved` rows, so the
 * resolutions agents post today (a decision on a comment) never showed. What
 * must hold, over the real routes (one project per case, so counts are exact):
 * - a pending resolution on a comment is counted;
 * - a resolution replaced by a newer plan is not;
 * - a closed ticket, or a snoozed one, is not.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2372-"));
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
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2372-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2372-w" }).token;

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
async function propose(p: string, ticketId: number, kind: "plan" | "resolution"): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", { project: p, kind: "comment_added", ticket_id: ticketId, body: kind, summary_until: "s", decision_kind: kind });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function pendingResolution(p: string): Promise<number> {
    const r = await call(HUMAN, "GET", `/api/projects/${p}/stats-rich`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json.pending_resolution as number;
}

test("a resolution proposed on a comment is counted", async () => {
    const p = project("p-2372-counted");
    const t = ticket(p, "a resolution waits");
    assert.equal(await pendingResolution(p), 0);
    await propose(p, t, "resolution");
    assert.equal(await pendingResolution(p), 1);
});

test("a resolution replaced by a newer plan is not counted", async () => {
    const p = project("p-2372-replaced");
    const t = ticket(p, "a resolution, then a plan");
    await propose(p, t, "resolution");
    await propose(p, t, "plan");
    assert.equal(await pendingResolution(p), 0);
});

test("a closed ticket, or a snoozed one, is not counted", async () => {
    const p = project("p-2372-out");
    const closed = ticket(p, "closed while a resolution waits");
    await propose(p, closed, "resolution");
    const snoozed = ticket(p, "snoozed while a resolution waits");
    await propose(p, snoozed, "resolution");
    assert.equal(await pendingResolution(p), 2, "both counted while open and awake");

    assert.equal(submitMessage({ project: p, kind: "ticket_closed", ticket_id: closed, by_agent: "boss" }).status, "approved");
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    assert.ok((await call(HUMAN, "POST", `/api/tickets/${snoozed}/postpone`, { until })).status < 300);
    assert.equal(await pendingResolution(p), 0);
});

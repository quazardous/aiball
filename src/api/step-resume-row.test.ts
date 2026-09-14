/**
 * #2456 david — a ticket whose step waits (`continue_after_minutes`) shows when
 * its agent resumes. What must hold, over the real routes:
 * - the list row of a waiting step carries `step_resume_at`;
 * - a step that carries on at once carries none;
 * - a waiting step is not flagged "stalled" before it is even due.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2456-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { setConfigOverride } = await import("../db/config-overrides.js");
const schema = await import("../schema.js");

const P = "p-2456";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2456-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2456-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
// A step stalls after one hour here — shorter than the wait declared below.
setConfigOverride(P, "tickets.step_stale_hours", 1);

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
async function step(ticketId: number, minutes: number): Promise<void> {
    await call(WORKER, "POST", `/api/tickets/${ticketId}/assign`, {});
    const r = await call(WORKER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", step: true, step_after_minutes: minutes,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function row(ticketId: number): Promise<{ latest_is_step: boolean; stalled_step: boolean; step_resume_at: string | null }> {
    const r = await call(HUMAN, "GET", `/api/inbox?ids=${ticketId}&project=${P}`);
    return (r.json as { latest_is_step: boolean; stalled_step: boolean; step_resume_at: string | null }[])[0]!;
}

test("a waiting step's row carries its resume time", async () => {
    const t = ticket("waiting on a build");
    await step(t, 90);

    const r = await row(t);
    assert.equal(r.latest_is_step, true);
    assert.ok(r.step_resume_at, "the resume is on the row");
    const inMinutes = (Date.parse(r.step_resume_at!) - Date.now()) / 60_000;
    assert.ok(inMinutes > 89 && inMinutes <= 90, `resumes in ${inMinutes.toFixed(1)} min, expected the 90 declared`);
});

test("a step that carries on at once carries no resume time", async () => {
    const t = ticket("carrying on");
    await step(t, 0);

    assert.equal((await row(t)).step_resume_at, null);
});

test("a waiting step is not stalled before it is due, even past the stale window", async () => {
    const t = ticket("a long wait");
    await step(t, 90);
    // Move the step itself two hours back, its declared resume still ahead.
    const at = new Date(Date.now() - 2 * 3600_000).toISOString();
    getDb().update(schema.messages).set({ createdAt: at })
        .where((await import("drizzle-orm")).eq(schema.messages.ticketId, t)).run();
    (await import("../db/inbox-agg.js")).invalidateInboxAgg(P, t);

    assert.equal((await row(t)).stalled_step, false, "its staleness counts from the resume");
});

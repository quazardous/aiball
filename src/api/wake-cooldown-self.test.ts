/**
 * #2386 — a backlog wake asks the woken agent for a gesture, and a comment is
 * one. Counting that answer as "the thread moved" voided the cooldown the wake
 * had just set, so the ticket came straight back. What must hold, over the real
 * routes:
 * - the woken agent's own comment leaves the ticket sunk for the cooldown;
 * - anyone else's word still lifts it at once — that is news, and the point of
 *   the rule;
 * - a step is the exception: it says "I carry on", so the agent's own step
 *   still lifts the sink at once, as it did before.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2386-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const COOLDOWN = 600;
const P = "p-2386";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "other", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2386-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2386-w" }).token;
const OTHER = issueToken({ kind: "agent", consumer_id: "other", label: "2386-o" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("other", P, "owner");

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
async function wake(ticketId: number): Promise<void> {
    const r = await call(WORKER, "POST", "/api/backlog-wake", { consumer_id: "worker", ticket_id: ticketId });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function comment(token: string, ticketId: number, extra: Record<string, unknown> = {}): Promise<void> {
    const r = await call(token, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", ...extra,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
/** Seconds the ticket stays out of the worker's wake pool from now (0 = a candidate). */
async function cooledFor(ticketId: number): Promise<number> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${P}&backlog=1&limit=500&cooldown_sec=${COOLDOWN}`);
    const rows = r.json as { id: number; backlog_cooled_until: string | null }[];
    const row = rows.find((x) => x.id === ticketId);
    assert.ok(row, `#${ticketId} in the worker's backlog`);
    return row!.backlog_cooled_until ? Math.round((Date.parse(row!.backlog_cooled_until) - Date.now()) / 1000) : 0;
}

test("the woken agent's own answer does not void the cooldown the wake just set", async () => {
    const t = ticket("the agent answers the wake it got");
    await wake(t);
    assert.ok(await cooledFor(t) > 0, "precondition: the wake sank it");

    await comment(WORKER, t, { handback: true });

    const held = await cooledFor(t);
    assert.ok(held > 0 && held <= COOLDOWN, `still sunk for ${held}s, expected the cooldown to hold`);
});

test("someone else's word still lifts the cooldown at once", async () => {
    const byHuman = ticket("the human replies after the wake");
    const byAgent = ticket("another agent replies after the wake");
    await wake(byHuman);
    await wake(byAgent);

    await comment(HUMAN, byHuman);
    await comment(OTHER, byAgent, { handback: true });

    assert.equal(await cooledFor(byHuman), 0, "a human's reply is news");
    assert.equal(await cooledFor(byAgent), 0, "another agent's reply is news");
});

test("the agent's own step still lifts the sink at once — it says there is work now", async () => {
    const t = ticket("the agent marks a step after the wake");
    await call(WORKER, "POST", `/api/tickets/${t}/assign`, {}); // self-claim
    await wake(t);

    await comment(WORKER, t, { step: true });

    assert.equal(await cooledFor(t), 0, "a step is the one own word that lifts the sink");
});

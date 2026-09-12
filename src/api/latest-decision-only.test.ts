/**
 * #2376 david `dvqfvt` (cases 3, 4 and 11) — what a comment and a replaced
 * decision do to a ticket whose decision is still pending. What must hold, over
 * the real routes:
 * - a HUMAN's comment hands the ticket back to the agent, whose job is then to
 *   confirm or amend its `then:` (david `a6zkyf`);
 * - another AGENT's comment does not: the human still owes the decision;
 * - only the latest decision of a thread can be accepted or rejected — a
 *   replaced one is refused with its reason, and the newer one still decides.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2376-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2376";
getDb();
// Comment ids must not collide with ticket ids (as tests/lib.ts seedCounters says).
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
upsertConsumer({ consumer_id: "neighbour", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "2376-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2376-w" }).token;
const NEIGHBOUR = issueToken({ kind: "agent", consumer_id: "neighbour", label: "2376-n" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
upsertSubscription("neighbour", P, "follower");

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
function ticket(title: string): number {
    return submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
}
async function propose(ticketId: number, kind: "plan" | "resolution"): Promise<number> {
    const r = await call(WORKER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: ticketId, body: "b", summary_until: "s", decision_kind: kind,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return r.json.id as number;
}
async function comment(token: string, ticketId: number): Promise<void> {
    const r = await call(token, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: ticketId, body: "a word", summary_until: "s", handback: true,
    });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
async function workerActionable(ticketId: number): Promise<boolean> {
    const r = await call(WORKER, "GET", `/api/tickets?project=${P}&actionable=1&limit=500`);
    return (r.json as unknown as { id: number }[]).some((row) => row.id === ticketId);
}

test("a human's comment hands the ticket back to the agent, pending decision and all", async () => {
    const t = ticket("the human speaks while a plan waits");
    await propose(t, "plan");
    assert.equal(await workerActionable(t), false, "precondition: the pending plan gates it");

    await comment(HUMAN, t);

    assert.equal(await workerActionable(t), true, "the agent has it back, to confirm or amend its then:");
});

test("another agent's comment does not: the human still owes the decision", async () => {
    const t = ticket("a neighbour speaks while a plan waits");
    await propose(t, "plan");

    await comment(NEIGHBOUR, t);

    assert.equal(await workerActionable(t), false, "still gated by the pending plan");
});

test("only the latest decision can be decided; the replaced one is refused with its reason", async () => {
    const t = ticket("a plan, then a fresher one");
    const first = await propose(t, "plan");
    const second = await propose(t, "plan");

    const stale = await call(HUMAN, "POST", `/api/messages/${first}/decide`, { status: "accepted" });
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
    assert.match(String(stale.json.error), /newer decision/);

    const live = await call(HUMAN, "POST", `/api/messages/${second}/decide`, { status: "accepted" });
    assert.equal(live.status, 200, JSON.stringify(live.json));
    assert.equal(await workerActionable(t), true, "an accepted plan is the go-signal");
});

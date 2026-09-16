/**
 * #2649 — "Your pending decision gates this" was sent to every owner of the
 * project whenever ANY agent's plan waited for its accept. What must hold, over
 * the real routes, with three agents owning one project:
 * - my plan, waiting, with another agent speaking after it: in my backlog (follow-up,
 *   or the hot tier while that word is fresh);
 * - the same ticket in the other owners' backlogs: absent (not their move);
 * - a ticket filed with then: plan by another agent: absent from mine too.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2649-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");

const P = "p-2649";
getDb();
getDb().insert(schema.settings).values({ key: "next_message_id", value: "1000000" })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: "1000000" } }).run();
upsertConsumer({ consumer_id: "boss", kind: "human" });
createProject({ name: P });
const tokens: Record<string, string> = {};
for (const a of ["alice", "bob", "carol"]) {
    upsertConsumer({ consumer_id: a, kind: "agent" });
    upsertSubscription(a, P, "owner");
    tokens[a] = issueToken({ kind: "agent", consumer_id: a, label: `2649-${a}` }).token;
}

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(as: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${tokens[as]}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() };
}
async function tier(as: string, ticketId: number): Promise<number | null | undefined> {
    const rows = (await call(as, "GET", `/api/tickets?project=${P}&backlog=1&limit=500`)).json as Array<{ id: number; backlog_tier: number | null }>;
    return rows.find((r) => r.id === ticketId)?.backlog_tier;
}

test("my waiting plan is my follow-up; the other owners do not get it", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "t", body: "x", by_agent: "boss" }).id;
    const plan = await call("alice", "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: t, body: "plan", summary_until: "s", decision_kind: "plan" });
    assert.ok(plan.status < 300, JSON.stringify(plan.json));
    const bobSays = await call("bob", "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: t, body: "a remark", summary_until: "s", handback: true });
    assert.ok(bobSays.status < 300, JSON.stringify(bobSays.json));

    // Fresh activity by someone else ranks it on the hot tier (0): what matters is that it is in her pool.
    assert.ok([0, 2].includes((await tier("alice", t)) as number), "alice: her plan waits, someone else spoke — in her backlog");
    assert.equal(await tier("carol", t) ?? null, null, "carol: not her decision, not her move");
    assert.equal(await tier("bob", t) ?? null, null, "bob: he spoke last and the gate is not his either");
});

test("a ticket filed with then: plan by another agent stays out of my backlog", async () => {
    const r = await call("alice", "POST", "/api/messages", { project: P, kind: "ticket_created", title: "filed with a plan", body: "x", decision_kind: "plan" });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    const t = (r.json as { id: number }).id;
    getDb().update(schema.tickets).set({ status: "approved" }).run();
    await call("bob", "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: t, body: "note", summary_until: "s", handback: true });
    assert.equal(await tier("carol", t) ?? null, null);
    assert.ok([0, 2].includes((await tier("alice", t)) as number));
});

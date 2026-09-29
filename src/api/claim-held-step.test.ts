/**
 * #2460 — "does the agent hold this ticket?" had two answers. A rival's claim
 * met the #2379 protection (the holder's last action + 60 min); the step gate
 * and the header read the assign window from the claim alone (4 h). An agent
 * still working five hours after claiming was protected against rivals, shown
 * as claiming, and refused its own `then: continue`. What must hold now:
 * - a holder still acting on the ticket past the window keeps it: step accepted,
 *   header `is_claim: true`, `claim_until` from its last action;
 * - a claim past both clocks is lapsed everywhere: the header says so, the step
 *   is refused with a reason naming the lapse, and `ticket_claim` renews it.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2460-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const schema = await import("../schema.js");
const { and, eq } = await import("drizzle-orm");

const P = "p-2460";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "2460-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

function call(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    return asToken<Record<string, unknown>>(WORKER, method, params);
}
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const step = (id: number) => call("message.post", {
    project: P, kind: "comment_added", ticket_id: id, body: "step", summary_until: "s", step: true, step_after_minutes: 0,
});
const header = async (id: number) => (await call("ticket.get", { id })).json.ticket as Record<string, unknown>;

/** A ticket the worker claimed `claimedMin` ago and last commented on `actedMin` ago. */
async function claimedTicket(claimedMin: number, actedMin: number): Promise<number> {
    const id = submitMessage({ project: P, kind: "ticket_created", title: "work", body: "x", by_agent: "boss" }).id;
    assert.equal((await call("ticket.assign", { id })).status, 200);
    const c = submitMessage({ project: P, kind: "comment_added", ticket_id: id, parent_id: id, body: "working", by_agent: "worker", summary_until: "s", handback: false });
    getDb().update(schema.tickets).set({ claimedAt: ago(claimedMin) }).where(eq(schema.tickets.id, id)).run();
    getDb().update(schema.messages).set({ createdAt: ago(actedMin) })
        .where(and(eq(schema.messages.id, c.id), eq(schema.messages.byAgent, "worker"))).run();
    return id;
}

test("still working five hours after claiming: the claim holds, the step is accepted", async () => {
    const id = await claimedTicket(300, 20);
    const h = await header(id);
    assert.equal(h.is_claim, true);
    const until = Date.parse(String(h.claim_until));
    assert.ok(Math.abs(until - (Date.now() + 40 * 60_000)) < 60_000, `claim_until ≈ last action + 60 min, got ${h.claim_until}`);
    const r = await step(id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
});

test("past both clocks the claim has lapsed everywhere, and claiming again renews it", async () => {
    const id = await claimedTicket(300, 90);
    const h = await header(id);
    assert.equal(h.claimant, "worker", "the claim stays on record");
    assert.equal(h.is_claim, false);

    // #2781 david — "si on continue on claim aussi": the step renews the lapsed
    // claim of the agent it belonged to, instead of refusing it.
    const r = await step(id);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((await header(id)).is_claim, true, "the step claimed it again");
});

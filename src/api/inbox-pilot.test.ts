/**
 * #3005 — `/api/inbox?v=tvty` gives each row whose turn it is, its band and its
 * state glyph, computed by the server for the viewer. What must hold, over the
 * real routes:
 * - `turn` follows the actionable gate, not the last comment: a decision taken
 *   or a ticket reopened without a word hands the ball over; a viewer alone on
 *   a thread keeps it; a step keeps it with its author;
 * - a pending decision proposed by someone else puts the row in the decision
 *   band, and outranks a later step for the glyph;
 * - without `v`, the rows are exactly what they were; `sort=band` orders by band.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3005-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { BANDS } = await import("./inbox-pilot.js");

const P = "p-3005";
getDb();
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3005-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3005-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");

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
async function comment(token: string, ticketId: number, extra: Record<string, unknown> = {}): Promise<number> {
    const r = await call(token, "POST", "/api/messages", { project: P, kind: "comment_added", ticket_id: ticketId, body: "c", summary_until: "s", handback: true, ...extra });
    assert.ok(r.status < 300, JSON.stringify(r.json));
    return (r.json as { id: number }).id;
}
async function decide(messageId: number, status: "accepted" | "rejected"): Promise<void> {
    const r = await call(HUMAN, "POST", `/api/messages/${messageId}/decide`, { status });
    assert.ok(r.status < 300, JSON.stringify(r.json));
}
type Row = { id: number; last_speaker: string; turn?: string; band?: number; state_glyph?: string | null };
async function row(ticketId: number, token = HUMAN): Promise<Row> {
    const r = await call(token, "GET", `/api/inbox?v=tvty&ids=${ticketId}&project=${P}`);
    const rows = r.json as Row[];
    assert.equal(rows.length, 1, JSON.stringify(r.json));
    return rows[0]!;
}
const band = (name: (typeof BANDS)[number]) => BANDS.indexOf(name);

test("a plan accepted without a comment hands the ball to the agent, though the agent spoke last", async () => {
    const t = ticket("plan accepted silently");
    const plan = await comment(WORKER, t, { decision_kind: "plan", handback: undefined });
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["you", band("decision"), "plan"]);
    await decide(plan, "accepted");
    r = await row(t);
    assert.equal(r.last_speaker, "worker", "a client reading last_speaker would say it is the human's turn");
    assert.equal(r.turn, "them");
    assert.equal(r.state_glyph, null);
});

test("a ticket reopened without a comment hands the ball back", async () => {
    const t = ticket("reopened silently");
    await comment(WORKER, t);
    assert.ok((await call(HUMAN, "POST", "/api/messages", { project: P, kind: "ticket_closed", ticket_id: t })).status < 300);
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["none", band("closed"), "closed"]);
    assert.ok((await call(HUMAN, "POST", "/api/messages", { project: P, kind: "ticket_reopened", ticket_id: t })).status < 300);
    r = await row(t);
    assert.equal(r.last_speaker, "worker");
    assert.equal(r.turn, "them");
});

test("a viewer alone on a thread, commenting several times, keeps the ball", async () => {
    const t = ticket("alone");
    await comment(HUMAN, t);
    await comment(HUMAN, t);
    assert.equal((await row(t)).turn, "you");
});

test("a step keeps the ball with its author, and a pending decision outranks it", async () => {
    const t = ticket("step");
    await comment(WORKER, t, { step: true, step_after_minutes: 0, handback: undefined });
    let r = await row(t);
    assert.deepEqual([r.turn, r.band, r.state_glyph], ["them", band("unread"), "step"], "unread comes before working");
    assert.ok((await call(HUMAN, "POST", `/api/tickets/${t}/mark-read`)).status < 300);
    r = await row(t);
    assert.equal(r.band, band("working"));
    assert.equal((await row(t, WORKER)).turn, "you", "for its author, a step is still its turn");

    const u = ticket("plan then step");
    await comment(WORKER, u, { decision_kind: "plan", handback: undefined });
    await comment(WORKER, u, { step: true, step_after_minutes: 0, handback: undefined });
    r = await row(u);
    assert.deepEqual([r.band, r.state_glyph], [band("decision"), "plan"]);
});

test("the decision band is the viewer's to decide, not the proposer's", async () => {
    const t = ticket("worker's own plan");
    await comment(WORKER, t, { decision_kind: "plan", handback: undefined });
    await comment(HUMAN, t);
    let r = await row(t);
    assert.deepEqual([r.turn, r.band], ["them", band("decision")], "a question after the plan: the plan still waits on the human");
    r = await row(t, WORKER);
    assert.notEqual(r.band, band("decision"), "the proposer does not decide its own plan");
});

test("without v the rows are unchanged, and sort=band orders by band", async () => {
    const plain = await call(HUMAN, "GET", `/api/inbox?project=${P}`);
    for (const r of plain.json as Row[]) assert.ok(!("turn" in r) && !("band" in r) && !("state_glyph" in r));
    const sorted = (await call(HUMAN, "GET", `/api/inbox?v=tvty&sort=band&project=${P}`)).json as Row[];
    const bands = sorted.map((r) => r.band!);
    assert.deepEqual(bands, [...bands].sort((a, b) => a - b));
    assert.ok(new Set(bands).size > 2, "several bands are exercised");
});

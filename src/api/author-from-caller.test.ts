/**
 * #3036 — the author of a write is the authenticated caller, never a name in
 * the body. Over the real routes, with tokens (TCP, where the caller is bound
 * to its token):
 * - a body naming someone else is refused whole (403 AUTHOR_MISMATCH), and
 *   nothing is written;
 * - a body naming the caller is accepted; a body naming nobody gets the caller;
 * - the same for the other author fields: set_by, answered_by, decided_by.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3036-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer, getMessage } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { upsertSubscription } = await import("../db/subscriptions.js");
const { insertTag } = await import("../db/tags.js");

const P = "p-3036";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3036-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3036-w" }).token;
createProject({ name: P });
upsertSubscription("worker", P, "owner");
insertTag({ name: "t-3036" });

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
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
const ticket = (title: string) => submitMessage({ project: P, kind: "ticket_created", title, body: "x", by_agent: "boss" }).id;
const comment = (t: number, extra: Record<string, unknown> = {}) => ({
    project: P, kind: "comment_added", ticket_id: t, body: "c", summary_until: "s", handback: true, commits: null, ...extra,
});

test("a comment signed by someone else is refused, and not written", async () => {
    const t = ticket("impersonation");
    const r = await call(WORKER, "POST", "/api/messages", comment(t, { by_agent: "boss" }));
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "AUTHOR_MISMATCH");
    const thread = (await call(HUMAN, "GET", `/api/tickets/${t}?full=1`)).json as { comments: unknown[] };
    assert.equal(thread.comments.length, 0, "nothing was posted");
});

test("signed by the caller, or not signed: the caller is the author", async () => {
    const t = ticket("honest");
    for (const extra of [{ by_agent: "worker" }, {}]) {
        const r = await call(WORKER, "POST", "/api/messages", comment(t, extra));
        assert.equal(r.status, 201, JSON.stringify(r.json));
        assert.equal(getMessage(r.json.id as number)?.by_agent, "worker");
    }
});

test("the other author fields: set_by, answered_by, decided_by", async () => {
    const t = ticket("fields");
    const tags = await call(WORKER, "PUT", `/api/messages/${t}/tags`, { tag_ids: ["t-3036"], set_by: "boss" });
    assert.deepEqual([tags.status, tags.json.code], [403, "AUTHOR_MISMATCH"], "set_by");
    assert.equal((await call(WORKER, "PUT", `/api/messages/${t}/tags`, { tag_ids: ["t-3036"] })).status, 200, "set_by left out");

    const answer = await call(WORKER, "POST", `/api/messages/${t}/questions/q1/answer`, { answered_by: "boss", answered_in: 1 });
    assert.deepEqual([answer.status, answer.json.code], [403, "AUTHOR_MISMATCH"], "answered_by");

    const plan = submitMessage({ project: P, kind: "comment_added", ticket_id: t, body: "plan", by_agent: "worker", decision_kind: "plan", summary_until: "p" }).id;
    const decide = await call(HUMAN, "POST", `/api/messages/${plan}/decide`, { status: "accepted", decided_by: "worker" });
    assert.deepEqual([decide.status, decide.json.code], [403, "AUTHOR_MISMATCH"], "decided_by");
    const ok = await call(HUMAN, "POST", `/api/messages/${plan}/decide`, { status: "accepted" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const meta = JSON.parse(getMessage(plan)?.meta ?? "{}") as { decision?: { decided_by?: string } };
    assert.equal(meta.decision?.decided_by, "boss");
});

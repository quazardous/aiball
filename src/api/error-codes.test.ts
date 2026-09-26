/**
 * #3039 — refusals as `{ error, code }`, over the real routes:
 * - the precise codes a client reacts on (authentication, moderator-only, a
 *   message that does not exist, a step waiting too long, a released
 *   milestone, a superseded decision);
 * - the net: a hand-written refusal without a code gets its status's generic one.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3039-"));
process.env.AIBALL_SOCK = "";

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { errorCodeDefaults } = await import("./error-codes.js");

const P = "p-3039";
upsertConsumer({ consumer_id: "boss", kind: "human" });
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const HUMAN = issueToken({ kind: "agent", consumer_id: "boss", label: "3039-h" }).token;
const WORKER = issueToken({ kind: "agent", consumer_id: "worker", label: "3039-w" }).token;
createProject({ name: P });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function call(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
}
const refusal = (r: { status: number; json: Record<string, unknown> }) => ({ status: r.status, code: r.json.code, hasSentence: typeof r.json.error === "string" });

test("authentication: no token, and a token nobody issued", async () => {
    assert.deepEqual(refusal(await call(null, "GET", "/api/tags")), { status: 401, code: "AUTH_REQUIRED", hasSentence: true });
    assert.deepEqual(refusal(await call("not-a-token", "GET", "/api/tags")), { status: 401, code: "TOKEN_INVALID", hasSentence: true });
});

test("a moderator's gesture asked by an agent", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "snooze me", body: "x", by_agent: "boss" }).id;
    const r = await call(WORKER, "POST", `/api/tickets/${t}/postpone`, { until: new Date(Date.now() + 3_600_000).toISOString() });
    assert.deepEqual(refusal(r), { status: 403, code: "MODERATOR_ONLY", hasSentence: true });
});

test("a message that does not exist", async () => {
    assert.deepEqual(refusal(await call(HUMAN, "GET", "/api/messages/987654321")), { status: 404, code: "MESSAGE_NOT_FOUND", hasSentence: true });
});

test("a step that would wait longer than the project allows", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "a step", body: "x", by_agent: "boss" }).id;
    const r = await call(WORKER, "POST", "/api/messages", {
        project: P, kind: "comment_added", ticket_id: t, body: "later", summary_until: "s",
        step: true, step_after_minutes: 100_000, commits: null,
    });
    assert.deepEqual(refusal(r), { status: 400, code: "STEP_TIMER_TOO_LONG", hasSentence: true });
});

test("putting a ticket in a released milestone", async () => {
    const m = submitMessage({ project: P, kind: "ticket_created", title: "v1", body: "x", by_agent: "boss" }).id;
    assert.equal((await call(HUMAN, "POST", `/api/messages/${m}/edit`, { level: "milestone" })).status, 200);
    submitMessage({ project: P, kind: "ticket_closed", ticket_id: m, parent_id: m, body: "released", by_agent: "boss" });
    const t = submitMessage({ project: P, kind: "ticket_created", title: "late", body: "x", by_agent: "boss" }).id;
    assert.deepEqual(refusal(await call(HUMAN, "POST", `/api/tickets/${t}/milestone`, { milestone_id: m })), { status: 400, code: "MILESTONE_RELEASED", hasSentence: true });
    assert.deepEqual(refusal(await call(HUMAN, "POST", `/api/tickets/${t}/milestone`, { milestone_id: t })), { status: 400, code: "MILESTONE_INVALID", hasSentence: true });
});

test("deciding a proposal a newer one replaced", async () => {
    const t = submitMessage({ project: P, kind: "ticket_created", title: "two plans", body: "x", by_agent: "boss" }).id;
    const first = submitMessage({ project: P, kind: "comment_added", ticket_id: t, body: "plan A", by_agent: "worker", decision_kind: "plan", summary_until: "a" }).id;
    submitMessage({ project: P, kind: "comment_added", ticket_id: t, body: "plan B", by_agent: "worker", decision_kind: "plan", summary_until: "b" });
    const r = await call(HUMAN, "POST", `/api/messages/${first}/decide`, { status: "accepted" });
    assert.deepEqual(refusal(r), { status: 409, code: "DECISION_SUPERSEDED", hasSentence: true });
});

test("the net: a refusal written without a code gets its status's generic one; a code set stays", async () => {
    const app = express();
    app.use(errorCodeDefaults);
    app.get("/raw", (_req, res) => { res.status(409).json({ error: "taken", extra: 1 }); });
    app.get("/coded", (_req, res) => { res.status(409).json({ error: "taken", code: "TICKET_HELD" }); });
    app.get("/ok", (_req, res) => { res.json({ error: "a field, not a refusal" }); });
    const s = app.listen(0);
    await new Promise<void>((r) => s.once("listening", () => r()));
    const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
        assert.deepEqual(await (await fetch(`${base}/raw`)).json(), { error: "taken", extra: 1, code: "CONFLICT" });
        assert.deepEqual(await (await fetch(`${base}/coded`)).json(), { error: "taken", code: "TICKET_HELD" });
        assert.deepEqual(await (await fetch(`${base}/ok`)).json(), { error: "a field, not a refusal" }, "a 200 is left alone");
    } finally {
        s.close();
    }
});

test("a malformed body is a coded refusal too", async () => {
    const r = await fetch(`${BASE}/api/messages`, { method: "POST", headers: { authorization: `Bearer ${HUMAN}`, "content-type": "application/json" }, body: "{not json" });
    assert.equal(r.status, 400);
    assert.equal((await r.json() as { code: string }).code, "BAD_REQUEST");
});

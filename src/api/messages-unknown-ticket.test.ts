/**
 * #2215 — a comment on a ticket that does not exist is a clean 404, and no
 * error ever comes back as Express's HTML page with a stack in it. Spawns the
 * real app on an ephemeral port for the HTTP cases.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2215-"));
process.env.AIBALL_SOCK = "";

const { createApp, jsonErrorHandler } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { createProject } = await import("../db/projects.js");
const { sql } = await import("drizzle-orm");

const db = getDb();
upsertConsumer({ consumer_id: "worker", kind: "agent" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "worker", label: "2215" }).token;
createProject({ name: "p-2215" });
const real = submitMessage({ project: "p-2215", kind: "ticket_created", title: "real", body: "x", by_agent: "worker" });

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
    server.close();
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const post = (body: string) => fetch(`${BASE}/api/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body,
});
const comment = (ticket_id: number) => JSON.stringify({
    project: "p-2215", kind: "comment_added", ticket_id, body: "x", by_agent: "worker", summary_until: "state", handback: true,
});
const messageCount = () => db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _messages`)[0].n;

test("a comment on a ticket that does not exist is a 404 in JSON, and nothing is written", async () => {
    const before = messageCount();
    const res = await post(comment(987654321));
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /ticket #987654321 does not exist/);
    assert.equal(messageCount(), before);
});

test("a comment on a real ticket still posts", async () => {
    const res = await post(comment(real.id));
    assert.equal(res.status, 201);
});

test("a malformed body is answered in JSON, not as an HTML error page", async () => {
    const res = await post("{not json");
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const text = await res.text();
    assert.equal(/<html|<pre>|\bat \S+ \(/i.test(text), false, text.slice(0, 200));
});

test("an unexpected error becomes a 500 that says nothing about the server", () => {
    const res = {
        headersSent: false,
        statusCode: 0,
        body: undefined as unknown,
        status(c: number) { this.statusCode = c; return this; },
        json(b: unknown) { this.body = b; return this; },
    };
    const original = console.error;
    console.error = () => {};
    try {
        jsonErrorHandler(
            new Error("SqliteError at /home/someone/secret/path.ts:12"),
            { method: "POST", originalUrl: "/api/x" } as never,
            res as never,
            () => {},
        );
    } finally {
        console.error = original;
    }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "internal error" });
});

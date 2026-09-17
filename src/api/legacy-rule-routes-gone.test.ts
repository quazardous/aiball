/**
 * #2697 / #2718 — the two legacy rule surfaces wrote tables their engine had
 * stopped reading: a rule or a filter was accepted, stored, listed, and changed
 * nothing. Both are gone; accepting one again would be worse than refusing it,
 * so the refusal is pinned here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2718-"));
process.env.AIBALL_SOCK = "";

const { getDb } = await import("../db/connection.js");
const { upsertConsumer } = await import("../db/consumers.js");
const { issueToken } = await import("../db/tokens.js");
const { createApp } = await import("../app.js");

getDb();
upsertConsumer({ consumer_id: "mod2718", kind: "human" });
const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const token = issueToken({ kind: "auth", consumer_id: "mod2718", label: "2718" }).token;

const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

test("the legacy rule and work-filter routes are gone, not silently accepting", async (t) => {
    t.after(() => { server.close(); });
    for (const [method, path, body] of [
        ["GET", "/api/rules", undefined],
        ["POST", "/api/rules", { decision: "review", match_project: "p" }],
        ["GET", "/api/work-filters", undefined],
        ["POST", "/api/work-filters", { consumer_id: "mod2718", match_tags: ["win"], mode: "only" }],
    ] as const) {
        const r = await call(method, path, body);
        assert.ok(r.status >= 400, `${method} ${path} should be refused, got ${r.status}`);
    }
    // The surface that replaced them still answers.
    assert.equal((await call("GET", "/api/automation/rules")).status, 200);
});

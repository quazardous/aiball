// #457 slice 4 — HTTP integration tests for the automation CRUD endpoints.
// Mounts the REAL app on an ephemeral port + drives it via fetch with a real
// bearer token (mints via tests/lib.ts-style provisioning, kept in-test so
// node:test reaches it without the e2e harness).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// Throwaway DB BEFORE any module that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-457-slice4-"));

const { createApp } = await import("../app.js");
const { issueToken } = await import("../db/tokens.js");
const { ensureConsumer } = await import("../db.js");

ensureConsumer("test-agent");
const TOKEN = issueToken({ kind: "agent", consumer_id: "test-agent", label: "slice4-test" }).token;

const server = createApp().listen(0);
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
const BASE = `http://127.0.0.1:${port}`;

const authHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
};

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const r = await fetch(`${BASE}${path}`, {
        method,
        headers: authHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: r.status, body: parsed };
}

test("POST /automation/rules : creates a rule with triggers union + assign action", async () => {
    const r = await req("POST", "/api/automation/rules", {
        triggers: ["ticket_created", "ticket_tagged"],
        match_project: "proj-x",
        match_tags: ["win"],
        action: { kind: "assign", consumer_id: "aiball-windows" },
        note: "win → windows",
    });
    assert.equal(r.status, 201);
    const body = r.body as Record<string, unknown>;
    assert.deepEqual(body.triggers, ["ticket_created", "ticket_tagged"]);
    assert.equal((body.action as { kind: string }).kind, "assign");
    assert.equal((body.action as { consumer_id: string }).consumer_id, "aiball-windows");
    assert.equal(body.enabled, 1);
});

test("POST /automation/rules : rejects unknown trigger", async () => {
    const r = await req("POST", "/api/automation/rules", {
        triggers: ["not_a_trigger"],
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /unknown trigger/);
});

test("POST /automation/rules : rejects empty triggers", async () => {
    const r = await req("POST", "/api/automation/rules", {
        triggers: [],
        action: { kind: "decision", decision: "auto" },
    });
    assert.equal(r.status, 400);
});

test("POST /automation/rules : rejects assign without consumer_id", async () => {
    const r = await req("POST", "/api/automation/rules", {
        triggers: ["ticket_created"],
        action: { kind: "assign" },
    });
    assert.equal(r.status, 400);
    assert.match(String((r.body as { error: string }).error), /consumer_id/);
});

test("POST /automation/rules : accepts a single trigger string (not just arrays)", async () => {
    const r = await req("POST", "/api/automation/rules", {
        triggers: "ticket_tagged",
        match_tag_added: "linux",
        action: { kind: "assign", consumer_id: "aiball-linux" },
    });
    assert.equal(r.status, 201);
    assert.deepEqual((r.body as { triggers: string[] }).triggers, ["ticket_tagged"]);
});

test("GET /automation/rules : lists every rule, ordered by (position, id)", async () => {
    const r = await req("GET", "/api/automation/rules");
    assert.equal(r.status, 200);
    const all = r.body as Array<{ id: number; position: number }>;
    // Slice 3 : YAML rules (id < 0) may be appended AFTER the DB rows. Their
    // declaration order is meaningful, not their id, so the position-asc /
    // id-asc invariant only applies to the DB slice.
    const dbRows = all.filter((row) => row.id > 0);
    assert.ok(dbRows.length >= 2, `at least the DB rules we created above are there (saw ${dbRows.length})`);
    for (let i = 1; i < dbRows.length; i++) {
        const prev = dbRows[i - 1]!;
        const cur = dbRows[i]!;
        assert.ok(
            prev.position < cur.position || (prev.position === cur.position && prev.id < cur.id),
            "DB rules ordered by (position asc, id asc)",
        );
    }
});

test("GET /automation/rules?trigger=… : filters to rules listing that trigger", async () => {
    const r = await req("GET", "/api/automation/rules?trigger=ticket_tagged");
    assert.equal(r.status, 200);
    const rows = r.body as Array<{ triggers: string[] }>;
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(row.triggers.includes("ticket_tagged"), "every row carries ticket_tagged");
    }
});

test("PATCH /automation/rules/:id : flips enabled", async () => {
    const created = await req("POST", "/api/automation/rules", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "review" },
    });
    const id = (created.body as { id: number }).id;
    const r = await req("PATCH", `/api/automation/rules/${id}`, { enabled: false });
    assert.equal(r.status, 200);
    assert.equal((r.body as { enabled: number }).enabled, 0);

    const back = await req("PATCH", `/api/automation/rules/${id}`, { enabled: true });
    assert.equal((back.body as { enabled: number }).enabled, 1);
});

test("PATCH /automation/rules/:id : rejects non-boolean enabled", async () => {
    const r = await req("PATCH", "/api/automation/rules/1", { enabled: "yes" });
    assert.equal(r.status, 400);
});

test("DELETE /automation/rules/:id : removes the row + 204s", async () => {
    const created = await req("POST", "/api/automation/rules", {
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "auto" },
    });
    const id = (created.body as { id: number }).id;
    const r = await req("DELETE", `/api/automation/rules/${id}`);
    assert.equal(r.status, 204);
    // Confirm it's gone via list.
    const list = await req("GET", "/api/automation/rules");
    const rows = list.body as Array<{ id: number }>;
    assert.ok(!rows.some((row) => row.id === id), "deleted row no longer surfaces in list");
});

after(() => {
    try { server.close(); } catch { /* noop */ }
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});

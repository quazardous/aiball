/**
 * #2198 — `message.list` with `summary` drops bodies in the daemon, so poll() no
 * longer ships every pending body across the socket for the MCP process to
 * throw away. The project filter and the limit poll now relies on are pinned
 * here too. Calls `message.list` over the bus.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2198-"));
process.env.AIBALL_SOCK = "";

const { asToken } = await import("../tests/bus-call.js");
const { issueToken } = await import("../db/tokens.js");
const { upsertConsumer } = await import("../db.js");
const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { updateMessageStatus } = await import("../db/messages.js");
const { createProject } = await import("../db/projects.js");

getDb();
upsertConsumer({ consumer_id: "drafter", kind: "agent" });
const TOKEN = issueToken({ kind: "agent", consumer_id: "drafter", label: "2198" }).token;
createProject({ name: "p1" });
createProject({ name: "p2" });

const BODY = "B".repeat(2000);
for (const project of ["p1", "p1", "p2"]) {
    const t = submitMessage({ project, kind: "ticket_created", title: `draft in ${project}`, body: BODY, by_agent: "drafter" });
    if (t.status !== "pending") updateMessageStatus(t.id, "pending", "human", null, "ticket_created");
}

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

type Row = Record<string, unknown>;
async function list(extra: Record<string, unknown>): Promise<Row[]> {
    const res = await asToken<Row[]>(TOKEN, "message.list", { kind: "ticket_created", status: "pending", by_agent: "drafter", ...extra });
    assert.equal(res.status, 200);
    return res.json;
}

test("summary=1 returns the rows without their bodies", async () => {
    const rows = await list({ summary: true });
    assert.equal(rows.length, 3);
    for (const r of rows) {
        assert.equal("body" in r, false, `row ${r.id} still carries its body`);
        assert.match(String(r.title), /^draft in p[12]$/);
    }
});

test("without summary the bodies are still there — the projection is opt-in", async () => {
    const rows = await list({});
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(String(r.body).length, BODY.length);
});

test("the project filter narrows on the daemon side", async () => {
    const rows = await list({ project: "p1", summary: true });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.project === "p1"));
});

test("limit caps the rows the daemon sends", async () => {
    assert.equal((await list({ summary: true, limit: 1 })).length, 1);
});

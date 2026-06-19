// #1031 — successive decisions on a ticket are AMENDMENTS : only the latest
// pending one is actionable (requires accept/reject), earlier ones are
// superseded history. `listPendingDecisionsForReporter` must rank them so a
// consumer renders the chain hierarchically instead of N flat "decisions".
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1031-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { listPendingDecisionsForReporter } = await import("./messages.js");

const PROJECT = "p1031";
const REPORTER = "claude-aiball-dev";

const db = getDb();
createProject({ name: PROJECT });

function mkTicket(id: number): void {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}`,
        status: "approved",
        byAgent: REPORTER,
        createdAt: nowIso(),
    }).run();
}

function mkDecision(opts: {
    id: number; ticketId: number; hashid: string;
    kind: "plan" | "resolution"; status: string; createdAt: string;
}): void {
    db.insert(schema.messages).values({
        id: opts.id,
        ticketId: opts.ticketId,
        kind: "comment_added",
        status: "approved",
        byAgent: REPORTER,
        hashid: opts.hashid,
        displaySeq: opts.id,
        createdAt: opts.createdAt,
        meta: JSON.stringify({ decision: { kind: opts.kind, status: opts.status } }),
    }).run();
}

after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

test("#1031 two successive pending plans → latest actionable, earlier superseded", () => {
    mkTicket(1);
    // older amendment then newer amendment (chain), both pending.
    mkDecision({ id: 101, ticketId: 1, hashid: "old111", kind: "plan", status: "pending", createdAt: "2026-01-01T00:00:00.000Z" });
    mkDecision({ id: 102, ticketId: 1, hashid: "new222", kind: "plan", status: "pending", createdAt: "2026-01-02T00:00:00.000Z" });

    const rows = listPendingDecisionsForReporter(REPORTER).filter((r) => r.ticket_id === 1);
    assert.equal(rows.length, 2);

    const latest = rows.find((r) => r.comment_hashid === "new222")!;
    const older = rows.find((r) => r.comment_hashid === "old111")!;

    assert.equal(latest.actionable, true, "latest is actionable");
    assert.equal(latest.superseded, false);
    assert.equal(latest.superseded_by, null);

    assert.equal(older.actionable, false, "older is NOT actionable");
    assert.equal(older.superseded, true);
    assert.equal(older.superseded_by, "new222", "older points at the live decision");
});

test("#1031 a lone pending decision is actionable, not superseded", () => {
    mkTicket(2);
    mkDecision({ id: 201, ticketId: 2, hashid: "solo99", kind: "resolution", status: "pending", createdAt: "2026-01-03T00:00:00.000Z" });

    const rows = listPendingDecisionsForReporter(REPORTER).filter((r) => r.ticket_id === 2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actionable, true);
    assert.equal(rows[0].superseded, false);
    assert.equal(rows[0].superseded_by, null);
});

test("#1031 ranking is per-ticket (one ticket's amendments don't affect another)", () => {
    // T1 has 2, T2 has 1 → exactly 2 actionable total across the two tickets.
    const all = listPendingDecisionsForReporter(REPORTER);
    const actionable = all.filter((r) => r.actionable);
    const superseded = all.filter((r) => r.superseded);
    assert.equal(actionable.length, 2, "one actionable per ticket (T1 + T2)");
    assert.equal(superseded.length, 1, "only T1's older amendment is superseded");
});

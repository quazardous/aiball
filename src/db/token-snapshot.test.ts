// #1200 — snapshot capture (throttled) + timeseries read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1200-"));
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { addProjectTokenUsage, addTicketTokenUsage } = await import("./token-usage.js");
const { captureTokenSnapshotIfDue, getTokenTimeseries } = await import("./token-snapshot.js");
getDb();

test("#1200 captures a snapshot per project, throttled", () => {
    createProject({ name: "tp1" });
    addProjectTokenUsage("tp1", { in: 100, out: 50 });
    const t0 = 1_000_000_000_000;
    const r1 = captureTokenSnapshotIfDue(3_600_000, t0);
    assert.equal(r1.captured, 1);
    // within the window → throttled, no new row
    const r2 = captureTokenSnapshotIfDue(3_600_000, t0 + 60_000);
    assert.equal(r2.captured, 0);
    // past the window → new row
    const r3 = captureTokenSnapshotIfDue(3_600_000, t0 + 3_700_000);
    assert.equal(r3.captured, 1);
    const series = getTokenTimeseries({ project: "tp1" });
    assert.equal(series.length, 2);
    assert.equal(series[0].tokens_in, 100);
});

test("#1200 snapshot sums direct + per-ticket usage (the flat-chart fix)", () => {
    createProject({ name: "tp3" });
    // direct (no-marker) tally
    addProjectTokenUsage("tp3", { in: 0, out: 200 });
    // two tickets in tp3 with their own usage — the bulk of a ticket-scoped
    // project's spend lives here, and used to be missing from the snapshot.
    getDb().insert(schema.tickets).values([
        { id: 8801, project: "tp3", displaySeq: 1, title: "A", status: "approved", createdAt: nowIso() },
        { id: 8802, project: "tp3", displaySeq: 2, title: "B", status: "approved", createdAt: nowIso() },
    ]).run();
    addTicketTokenUsage(8801, { out: 1000 });
    addTicketTokenUsage(8802, { out: 500 });
    captureTokenSnapshotIfDue(0, 3_000_000_000_000); // interval 0 → always captures
    const series = getTokenTimeseries({ project: "tp3" });
    const latest = series[series.length - 1];
    // 200 direct + 1000 + 500 per-ticket = 1700 combined (not just the 200).
    assert.equal(latest.tokens_out, 1700);
});

test("#1200 timeseries scopes by project + since", () => {
    createProject({ name: "tp2" });
    addProjectTokenUsage("tp2", { in: 7 });
    captureTokenSnapshotIfDue(0, 2_000_000_000_000); // interval 0 → always captures
    const only2 = getTokenTimeseries({ project: "tp2" });
    assert.ok(only2.every((r) => r.project === "tp2"));
    assert.ok(only2.length >= 1);
});

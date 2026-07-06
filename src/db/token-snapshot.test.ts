// #1200 — snapshot capture (throttled) + timeseries read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1200-"));
const { getDb } = await import("./connection.js");
const { createProject } = await import("./projects.js");
const { addProjectTokenUsage } = await import("./token-usage.js");
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

test("#1200 timeseries scopes by project + since", () => {
    createProject({ name: "tp2" });
    addProjectTokenUsage("tp2", { in: 7 });
    captureTokenSnapshotIfDue(0, 2_000_000_000_000); // interval 0 → always captures
    const only2 = getTokenTimeseries({ project: "tp2" });
    assert.ok(only2.every((r) => r.project === "tp2"));
    assert.ok(only2.length >= 1);
});

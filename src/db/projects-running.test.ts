// #968 david `ah6gyb` — la flag `p.running` doit être indexée par
// (project, cwd), pas par cwd seul. Cas concret : un consumer mort
// (testuser, project=test) partage son cwd avec un consumer live
// (claude-aiball-dev, project=aiball) → pre-fix `test.running` était
// `true` à tort parce que le set de running roots était global.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-968-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { listProjectsDetailed, createProject } = await import("./projects.js");
const { upsertConsumer } = await import("./consumers.js");
const { eq } = await import("drizzle-orm");

const db = getDb();
createProject({ name: "p968-live" });
createProject({ name: "p968-dead" });
upsertConsumer({ consumer_id: "live-agent", kind: "agent" });
upsertConsumer({ consumer_id: "dead-agent", kind: "agent" });

const SHARED_CWD = "/home/david/Private/dev/projects/quazardous/aiball";
const nowMs = Date.now();
const recentIso = new Date(nowMs - 5_000).toISOString(); // < 120s window
const staleIso = new Date(nowMs - 14 * 86_400_000).toISOString(); // 14 days

// Seed at least one ticket per project so the projects appear in
// listProjectsDetailed (it aggregates by ticket activity).
db.insert(schema.tickets).values([
    { id: 1, project: "p968-live", displaySeq: 1, title: "live", status: "approved", byAgent: "live-agent", createdAt: nowIso() },
    { id: 2, project: "p968-dead", displaySeq: 1, title: "dead", status: "approved", byAgent: "dead-agent", createdAt: nowIso() },
]).run();

// Both consumers share the SAME cwd. Only `live-agent` (project=p968-live)
// is currently running. `dead-agent` (project=p968-dead) reported state
// 14 days ago.
db.update(schema.consumers)
    .set({ project: "p968-live", cwd: SHARED_CWD, state: "idle", stateUpdatedAt: recentIso })
    .where(eq(schema.consumers.consumerId, "live-agent"))
    .run();
db.update(schema.consumers)
    .set({ project: "p968-dead", cwd: SHARED_CWD, state: "busy", stateUpdatedAt: staleIso })
    .where(eq(schema.consumers.consumerId, "dead-agent"))
    .run();

test("listProjectsDetailed: running flag est indexé par (project, cwd), pas par cwd seul", () => {
    const projects = listProjectsDetailed();
    const live = projects.find((p) => p.name === "p968-live");
    const dead = projects.find((p) => p.name === "p968-dead");
    assert.ok(live, "p968-live should appear in detailed list");
    assert.ok(dead, "p968-dead should appear in detailed list");
    assert.equal(live!.running, true, "p968-live has a live consumer → running=true");
    assert.equal(dead!.running, false, "p968-dead consumer is 14d stale → should be running=false despite sharing cwd with live-agent");
});

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* noop */ }
});

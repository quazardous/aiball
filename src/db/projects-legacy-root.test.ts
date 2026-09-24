// #3000 — the legacy root fallback (#393): a consumer that pushed a cwd but no
// project still gives its root to the projects it filed or commented on. The
// fallback now asks first whether any such consumer exists and skips its joins
// otherwise; this pins that the non-empty case still finds the root, and that
// a consumer with a project does not leak its root through the fallback.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-3000-root-"));
process.env.AIBALL_SOCK = "";

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { listProjectsDetailed, createProject, invalidateProjectsDetailed } = await import("./projects.js");
const { upsertConsumer } = await import("./consumers.js");
const { eq } = await import("drizzle-orm");

after(() => {
    try { rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }); } catch { /* ignore */ }
});

const db = getDb();
createProject({ name: "p-legacy" });
createProject({ name: "p-modern" });
upsertConsumer({ consumer_id: "legacy-agent", kind: "agent" });
upsertConsumer({ consumer_id: "modern-agent", kind: "agent" });
db.insert(schema.tickets).values([
    { id: 1, project: "p-legacy", displaySeq: 1, title: "filed by the legacy loop", status: "approved", byAgent: "legacy-agent", createdAt: nowIso() },
    { id: 2, project: "p-modern", displaySeq: 1, title: "filed by the modern loop", status: "approved", byAgent: "modern-agent", createdAt: nowIso() },
]).run();

test("a consumer with a cwd and no project gives its root to the project it filed on", () => {
    invalidateProjectsDetailed();
    assert.equal(listProjectsDetailed().find((p) => p.name === "p-legacy")?.local ?? false, false, "no cwd yet: not local");
    db.update(schema.consumers).set({ cwd: "/work/legacy" })
        .where(eq(schema.consumers.consumerId, "legacy-agent")).run();
    invalidateProjectsDetailed();
    const p = listProjectsDetailed().find((x) => x.name === "p-legacy");
    assert.equal(p?.local, true);
    assert.deepEqual(p?.roots, ["/work/legacy"]);
});

test("a consumer with a project gives its root to that project only, not through the fallback", () => {
    db.update(schema.consumers).set({ cwd: "/work/modern", project: "p-legacy" })
        .where(eq(schema.consumers.consumerId, "modern-agent")).run();
    invalidateProjectsDetailed();
    const modern = listProjectsDetailed().find((x) => x.name === "p-modern");
    assert.equal(modern?.local ?? false, false, "it filed on p-modern, but its project says p-legacy");
});

// #425 — deleteProject must also drop the `projects` registry row, else a
// project with 0 tickets keeps showing in listProjects (which merges the
// registry with DISTINCT tickets.project). node:test + tsx. Run: `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB before importing anything that reads paths (migrations run).
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-425-"));

const { createProject, deleteProject, listProjects, getProject } = await import("./projects.js");
const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");

test("deleteProject: an empty (0-ticket) registered project doesn't linger (#425)", () => {
    createProject({ name: "empty-proj" });
    assert.ok(listProjects().includes("empty-proj"), "registered project should be listed");
    deleteProject("empty-proj");
    assert.equal(getProject("empty-proj"), undefined, "registry row must be gone");
    assert.ok(!listProjects().includes("empty-proj"), "deleted project must not reappear");
});

test("deleteProject: drops the registry row AND its tickets; gone from the merged list", () => {
    createProject({ name: "withtix" });
    const db = getDb();
    db.insert(schema.tickets).values({ project: "withtix", displaySeq: 1, title: "t1", createdAt: nowIso() }).run();
    db.insert(schema.tickets).values({ project: "withtix", displaySeq: 2, title: "t2", createdAt: nowIso() }).run();
    assert.ok(listProjects().includes("withtix"));

    const { deleted_messages } = deleteProject("withtix");
    assert.equal(deleted_messages, 2, "2 tickets, 0 comments");
    assert.equal(getProject("withtix"), undefined);
    // listProjects merges registry + DISTINCT(tickets.project): excluded here
    // proves BOTH the registry row and the tickets were removed.
    assert.ok(!listProjects().includes("withtix"));
});

after(() => {
    try {
        rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true });
    } catch {
        /* best-effort temp cleanup */
    }
});

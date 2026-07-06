// #1185 — prunePings : mark-seen (défaut) ou delete, all-projects ou scopé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1185-"));

const { getDb } = await import("./connection.js");
const { createProject } = await import("./projects.js");
const { insertMessage } = await import("./messages.js");
const { insertPing, prunePings, listUnread } = await import("./pings.js");
getDb();

function seed(project: string, consumer: string, n: number): number[] {
    try { createProject({ name: project }); } catch { /* already exists */ }
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
        const t = insertMessage({ project, kind: "ticket_created", title: `t${i}`, by_agent: "x" });
        insertPing(consumer, { id: t.id, kind: "ticket_created", ticket_id: t.id });
        ids.push(t.id);
    }
    return ids;
}

test("#1185 mark-seen scoped to one project", () => {
    seed("p1", "carol", 3);
    seed("p2", "carol", 2);
    const r = prunePings("carol", { project: "p1" });
    assert.equal(r.affected, 3);
    // p2 pings untouched → still unread
    assert.equal(listUnread("carol", "p2", 100).length, 2);
    assert.equal(listUnread("carol", "p1", 100).length, 0);
});

test("#1185 mark-seen ALL projects", () => {
    seed("q1", "dave", 2);
    seed("q2", "dave", 2);
    const r = prunePings("dave", {});
    assert.equal(r.affected, 4);
    assert.equal(listUnread("dave", null, 100).length, 0);
});

test("#1185 delete removes the rows (even already-seen ones)", () => {
    seed("r1", "erin", 3);
    prunePings("erin", { project: "r1" });     // mark all seen first
    const r = prunePings("erin", { del: true }); // delete drops them regardless of seen
    assert.equal(r.affected, 3);
    // a second delete finds nothing
    assert.equal(prunePings("erin", { del: true }).affected, 0);
});

test("#1185 scopes by consumer (other consumer untouched)", () => {
    seed("s1", "frank", 2);
    seed("s1", "grace", 2);
    const r = prunePings("frank", { project: "s1" });
    assert.equal(r.affected, 2);
    assert.equal(listUnread("grace", "s1", 100).length, 2); // grace intacte
});

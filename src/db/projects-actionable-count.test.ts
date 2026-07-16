// #1368 — `actionable_count` (listProjectsDetailed) MUST agree with the
// canonical gate (`computeActionableTicketIds`). It used to re-derive the gate
// inline, and that copy had drifted: it applied the decision / blocked /
// depends_on / last-actor gates but MISSED the #418/#436 held-by-other
// exclusion. So a ticket assigned to ANOTHER agent counted as actionable for
// you — the loop armed its wake countdown on that phantom work, the backlog
// picker (canonical gate) then found nothing to surface, the drain skipped and
// re-armed forever (david's "syndrome event fantôme": `o:3 b:0 e:0 📨 Ns`), and
// the UI sidebar over-counted too.
//
// These tests pin the CONCORDANCE invariant so the two can't drift again.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1368-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { listProjectsDetailed, createProject, computeActionableTicketIds } = await import("./projects.js");

const PROJECT = "p1368";
const ME = "claude-aiball-dev";
const OTHER = "runic-win";
const HUMAN = "david";

const db = getDb();
createProject({ name: PROJECT });

/** An open, approved ticket whose last actor is the human (→ ball in the
 *  agent pool, not "awaiting someone else"). `assignee` optionally hands it to
 *  another agent — the #418/#436 held-by-other case. */
function mkTicket(id: number, opts: { assignee?: string } = {}) {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}${opts.assignee ? ` (assigned ${opts.assignee})` : " (unassigned)"}`,
        status: "approved",
        byAgent: HUMAN,
        assignee: opts.assignee ?? null,
        assignedBy: opts.assignee ? HUMAN : null,
        assignedAt: opts.assignee ? nowIso() : null,
        lastActor: HUMAN,
        lastActorAt: nowIso(),
        createdAt: nowIso(),
    }).run();
}

// T1 — unassigned, human spoke last → actionable for ME.
mkTicket(1);
// T2 — assigned to ANOTHER agent, human spoke last → NOT mine to act on.
//      This is the exact runic #763 shape that produced the phantom.
mkTicket(2, { assignee: OTHER });

function countFor(consumer: string): number {
    const p = listProjectsDetailed(consumer).find((x) => x.name === PROJECT);
    return p?.actionable_count ?? -1;
}
function canonicalFor(consumer: string): number {
    const { actionableIds } = computeActionableTicketIds(consumer);
    return [...actionableIds].filter((id) => id === 1 || id === 2).length;
}

test("#1368 a ticket assigned to ANOTHER agent is not counted in actionable_count", () => {
    // Only T1 is mine; T2 belongs to OTHER (held-by-other, #418/#436).
    assert.equal(countFor(ME), 1);
});

test("#1368 the other agent gets its own ticket counted (the exclusion is per-consumer)", () => {
    // Same data, other side of the fence: T2 is OTHER's, T1 is in the shared
    // pool (unassigned) → both are actionable for OTHER.
    assert.equal(countFor(OTHER), 2);
});

test("#1368 CONCORDANCE: actionable_count === the canonical gate's set size", () => {
    // The invariant that stops the two implementations drifting apart again.
    // Before the fix this failed for ME: count said 2, canonical said 1 — and
    // that gap was exactly the phantom's fuel.
    for (const consumer of [ME, OTHER, HUMAN]) {
        assert.equal(
            countFor(consumer),
            canonicalFor(consumer),
            `actionable_count must match computeActionableTicketIds for ${consumer}`,
        );
    }
});

after(() => rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true }));

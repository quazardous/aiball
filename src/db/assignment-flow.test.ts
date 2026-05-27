// #418 — in-process integration test of the assignment anti-collision gate.
// Drives a REAL throwaway SQLite (migration 0033 runs on the first getDb),
// exercising the full chain end-to-end: setTicketAssignee / releaseTicketAssignment
// + computeActionableTicketIds. This is the "2 agents on a shared project"
// simulation david asked for — without a daemon or Docker. The HTTP-level
// authority checks (push = moderator-only) + auto-release-on-close live in the
// e2e scenario (tests/scenario-assignment.ts, run under `npm run test:e2e`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

// Point the DB at a throwaway home BEFORE importing anything that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-418-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { computeActionableTicketIds } = await import("./projects.js");
const { setTicketClaim, setTicketAssignment, releaseTicketClaim } = await import("./tickets.js");

const A = "agent-a";
const B = "agent-b";
const PROJECT = "sim-418";

const db = getDb();
function seed(id: number) {
    // status 'approved' + no comments → last_actor null → in everyone's pool.
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}`,
        status: "approved",
        createdAt: nowIso(),
    }).run();
}
seed(1);
seed(2);
seed(3);

const actionable = (c: string) => computeActionableTicketIds(c).actionableIds;
const open = (c: string) => computeActionableTicketIds(c).openIds;

test("baseline: an unassigned ticket sits in BOTH agents' pool", () => {
    for (const id of [1, 2, 3]) {
        assert.ok(actionable(A).has(id), `T${id} actionable for A`);
        assert.ok(actionable(B).has(id), `T${id} actionable for B`);
    }
});

test("claim: a self-claim drops the ticket out of the OTHER agent's pool", () => {
    setTicketClaim(1, A); // A claims T1 (focus)
    assert.ok(actionable(A).has(1), "T1 stays actionable for the claimer A");
    assert.ok(!actionable(B).has(1), "T1 leaves B's pool (anti-collision)");
    assert.ok(open(B).has(1), "T1 is still OPEN for B — a real ticket, just not in B's court");
});

test("push: a moderator push to B → B sees it, A does not", () => {
    setTicketAssignment(2, B, "human"); // human pushes T2 onto B (responsibility)
    assert.ok(actionable(B).has(2), "T2 actionable for the assignee B");
    assert.ok(!actionable(A).has(2), "T2 leaves A's pool");
});

test("expiry: a stale claim lapses → ticket returns to the shared pool", () => {
    setTicketClaim(3, A); // A claims T3…
    // …but stamp the CLAIM 5h ago (> the default 4h window) → expired.
    const old = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    db.update(schema.tickets).set({ claimedAt: old }).where(eq(schema.tickets.id, 3)).run();
    assert.ok(actionable(A).has(3), "expired claim: T3 back for A");
    assert.ok(actionable(B).has(3), "expired claim: T3 back in B's pool");
});

test("release: handing it back returns the ticket to the pool", () => {
    releaseTicketClaim(1); // T1 was claimed by A earlier
    assert.ok(actionable(B).has(1), "released T1 back in B's pool");
    assert.ok(actionable(A).has(1), "released T1 still fine for A");
});

test("no double-pick: two live claims never collide on the same ticket", () => {
    // A holds T1 again, B holds T2: each sees its own, never the other's.
    setTicketClaim(1, A);
    // T2 still pushed to B from the earlier test. Re-assert the partition.
    assert.ok(actionable(A).has(1) && !actionable(B).has(1), "T1 is A's alone");
    assert.ok(actionable(B).has(2) && !actionable(A).has(2), "T2 is B's alone");
});

// #523 (david `reztjq` + `dzakgw`) — assignment auto-release le claim si
// claimant existant et claimant ≠ nouveau assignee.
test("#523 assign to Y ≠ claimant X → claim X libéré + retourné dans le rapport", () => {
    // T1 hold claim de A (cf. test précédent). On push à B (humain moderator).
    const before = db.select({ claimant: schema.tickets.claimant })
        .from(schema.tickets).where(eq(schema.tickets.id, 1)).get();
    assert.equal(before?.claimant, A, "pré-condition : A claim T1");

    const ar = setTicketAssignment(1, B, "human");
    assert.deepEqual(ar.released_claim, { ticket_id: 1, claimant: A },
        "released_claim signale A éjecté");

    const after = db.select({
        claimant: schema.tickets.claimant,
        assignee: schema.tickets.assignee,
    }).from(schema.tickets).where(eq(schema.tickets.id, 1)).get();
    assert.equal(after?.claimant, null, "claim A libéré côté DB");
    assert.equal(after?.assignee, B, "assignee = B");
});

test("#523 self-assign (assignee = claimant) → claim INCHANGÉ", () => {
    // Re-claim T1 pour A
    setTicketClaim(1, A);
    const ar = setTicketAssignment(1, A, "human"); // promote focus → responsabilité
    assert.equal(ar.released_claim, null, "pas de released_claim (self-assign)");

    const after = db.select({
        claimant: schema.tickets.claimant,
        assignee: schema.tickets.assignee,
    }).from(schema.tickets).where(eq(schema.tickets.id, 1)).get();
    assert.equal(after?.claimant, A, "claim A conservé (self-assign)");
    assert.equal(after?.assignee, A, "assignee = A");
});

test("#523 assign sans claim existant → released_claim null", () => {
    // T2 : claim a été release implicitement plus tôt + déjà assigné à B.
    releaseTicketClaim(2); // clean state
    db.update(schema.tickets)
        .set({ claimant: null, claimedAt: null })
        .where(eq(schema.tickets.id, 2)).run();
    const ar = setTicketAssignment(2, A, "human");
    assert.equal(ar.released_claim, null, "pas de claim à libérer → null");
});

after(() => {
    try {
        rmSync(process.env.AIBALL_HOME as string, { recursive: true, force: true });
    } catch {
        /* best-effort temp cleanup */
    }
});

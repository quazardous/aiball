// #1992 — the two questions the compiled graph answers.
//
// The property worth pinning hardest is what these DON'T do: a finding is a
// candidate, so nothing here may close, propose, or write. The detector that
// tried to conclude on its own produced 548 confident wrong answers, and the
// difference was never the algorithm — it was whether the claim could be cited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-1992q-"));

const { sql } = await import("drizzle-orm");
const { getDb } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject } = await import("./projects.js");
const { graphAudit, ticketNeighbors, LINK_WEIGHT, scopeOf } = await import("./graph-query.js");
const { upsertSubscription } = await import("./subscriptions.js");

const db = getDb();
const ACTOR = "claude-aiball-dev";
createProject({ name: "alpha" });
createProject({ name: "beta" });

const ticket = (id: number, project: string, title: string, body = "") =>
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title, body,
        status: "approved", byAgent: ACTOR, createdAt: "2026-09-01T10:00:00.000Z",
    }).run();

let nextMsg = 1_000_001;
const seqOf = new Map<number, number>();
const say = (ticketId: number, body: string, kind = "comment_added") => {
    const id = nextMsg++;
    const displaySeq = (seqOf.get(ticketId) ?? 0) + 1;
    seqOf.set(ticketId, displaySeq);
    db.insert(schema.messages).values({
        id, ticketId, kind, body, byAgent: ACTOR, status: "approved",
        createdAt: "2026-09-01T11:00:00.000Z", displaySeq,
    }).run();
    return id;
};
const close = (ticketId: number) => say(ticketId, "", "ticket_closed");

// A cohort that finished without #700: three closed tickets it writes about.
ticket(700, "alpha", "the one left behind");
for (const id of [701, 702, 703]) {
    ticket(id, "alpha", `cohort ${id}`);
    close(id);
}
// Each named TWICE: the audit only walks repeated links, since a pair named
// once is usually decoration. #703 mentioned a single time would not count.
say(700, "this follows #701, #702 and #703");
say(700, "same ground as #701, #702, #703");

// A cross-project pair, both open, named twice each way and never typed.
ticket(800, "alpha", "the alpha half");
ticket(801, "beta", "the beta half");
say(800, "blocked on #801");
say(800, "still waiting on #801");
say(801, "this is the other side of #800, see #800");

// A ticket whose neighbours are alive — must NOT be reported stale.
ticket(900, "alpha", "healthy");
ticket(901, "alpha", "alive neighbour");
say(900, "related to #901 and #901 again");

test("an open ticket whose whole cohort closed is a candidate", () => {
    const findings = graphAudit().findings.filter((f) => f.kind === "stale_open");
    const hit = findings.find((f) => f.ticket_ids[0] === 700);
    assert.ok(hit, "#700's three neighbours are all closed");
    assert.match(hit.detail, /all 3 tickets it names repeatedly/);
    assert.ok(hit.citation, "…and it says where it read that");
});

test("a stale candidate says who holds it, instead of being hidden or misread", () => {
    // From the first real run: all six candidates on aiball were held — five
    // claimed by the agent itself, one assigned to a machine offline for weeks.
    // Filtering them would have destroyed the useful reading ("you have been
    // sitting on this"); saying nothing let it read as "nobody noticed".
    const unheld = graphAudit().findings.find((f) => f.kind === "stale_open" && f.ticket_ids[0] === 700);
    assert.ok(unheld);
    assert.equal(unheld.held_by, undefined, "#700 is held by nobody");
    assert.match(unheld.detail, /nobody is holding it/);

    db.update(schema.tickets).set({ claimant: "someone-else" })
        .where(sql`id = 700`).run();
    const held = graphAudit().findings.find((f) => f.kind === "stale_open" && f.ticket_ids[0] === 700);
    assert.equal(held?.held_by?.claimant, "someone-else");
    assert.match(held.detail, /parked rather than forgotten/);
    db.update(schema.tickets).set({ claimant: null }).where(sql`id = 700`).run();
});

test("a ticket with a living neighbour is not stale", () => {
    const stale = graphAudit().findings.filter((f) => f.kind === "stale_open");
    assert.equal(stale.some((f) => f.ticket_ids[0] === 900), false);
});

test("two open tickets in different projects, unlinked, surface as a pair", () => {
    const pairs = graphAudit().findings.filter((f) => f.kind === "cross_project_open_pair");
    const hit = pairs.find((f) => f.ticket_ids.includes(800) && f.ticket_ids.includes(801));
    assert.ok(hit, "#800 ↔ #801 spans alpha and beta");
    assert.match(hit.detail, /no typed relation/);
    assert.equal(pairs.filter((f) => f.ticket_ids.includes(800)).length, 1, "reported once, not once per direction");
});

test("the audit reports what it scanned, so empty reads as clean", () => {
    const res = graphAudit();
    assert.ok(res.scanned > 0);
    assert.equal(typeof res.freshness.compiled, "boolean");
});

test("scoping to a project narrows the scan", () => {
    const beta = graphAudit({ project: "beta" });
    assert.ok(beta.scanned < graphAudit().scanned);
});

test("neighbours are ranked by weight and flag the foreign project", () => {
    const res = ticketNeighbors(800);
    const n = res.neighbors.find((x) => x.ticket_id === 801);
    assert.ok(n, "#801 is a neighbour");
    assert.equal(n.foreign_project, true, "it lives in another project");
    assert.equal(n.direction, "both", "each names the other");
    assert.ok(n.weight >= LINK_WEIGHT, `named ${n.weight} times`);
    assert.equal(n.typed_kind, undefined, "and no typed relation says so");
});

test("every neighbour carries a citation — an uncitable edge may not exist", () => {
    for (const n of ticketNeighbors(700).neighbors) {
        assert.ok(n.citation, `#${n.ticket_id} must say where it was read`);
        assert.equal(typeof n.citation.offset, "number");
    }
});

test("the audit writes nothing — it reports candidates, it does not act", () => {
    const count = () => db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM _messages`)[0].n;
    const before = count();
    graphAudit();
    const after = count();
    assert.equal(after, before, "no lifecycle event, no comment, no proposal");
});

// #1992 david `bzejyu` — "il faut quand même respecter les frontières projet :
// un agent voit une projection, avec éventuellement les limites communes".
//
// The graph is compiled corpus-wide (references cross projects, so a
// per-project compile could not see them). The READ is what must be bounded.
// These pin that an agent subscribed to `alpha` alone learns that a link
// leaves its project, and nothing about what is on the other side.

test("the human sees everything — no boundary", () => {
    assert.equal(scopeOf(undefined), null);
    assert.equal(scopeOf("human"), null);
});

test("an agent's projection is the projects it subscribes to", () => {
    upsertSubscription("agent-alpha", "alpha", "owner");
    const sc = scopeOf("agent-alpha");
    assert.ok(sc, "a real agent is bounded");
    assert.equal(sc.has("alpha"), true);
    assert.equal(sc.has("beta"), false);
});

test("a link leaving the projection is reported, but only as a boundary", () => {
    const res = ticketNeighbors(800, { consumerId: "agent-alpha" });
    const n = res.neighbors.find((x) => x.ticket_id === 801);
    assert.ok(n, "the LINK still shows — a dependency you cannot see is the one that hurts");
    assert.equal(n.beyond_scope, true);
    assert.equal(n.project, "beta", "…named by project, which is the shared limit");
    assert.equal(n.title, "", "but nothing about what is on the other side");
    assert.equal(n.stage, null);
});

test("asking about a ticket outside the projection returns nothing at all", () => {
    const res = ticketNeighbors(801, { consumerId: "agent-alpha" });
    assert.equal(res.out_of_scope, true);
    assert.deepEqual(res.neighbors, []);
    assert.equal(res.project, null, "not even which project it lives in");
});

test("the audit only reports findings ABOUT tickets in the projection", () => {
    const mine = graphAudit({ consumerId: "agent-alpha" });
    const ids = new Set(mine.findings.flatMap((f) => f.ticket_ids));
    assert.equal(ids.has(801), false, "beta's tickets are not agent-alpha's business");
    assert.ok(mine.scanned < graphAudit().scanned, "…and the scan itself is narrower");
});

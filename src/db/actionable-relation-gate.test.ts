// #2102 — the relation gate of `computeActionableTicketIds`, pinned BEFORE the
// function is scoped by ticket ids.
//
// This gate is the reason the function was called "not decomposable by ticket":
// answering "is X actionable?" requires the OPEN state of X's blockers, which
// are other tickets. Scoping the computation to a bucket of ids is therefore
// the one change that can silently drop a ticket out of somebody's queue — or
// silently leave a freed one gated.
//
// These tests characterise the behaviour as it stands today, so the scoping
// work has something to violate. The one that matters most is "closing the
// blocker frees the dependent": that is the write-on-X-changes-Y case, and it
// is what fixes the bucket's size.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2102-"));

const { getDb, nowIso } = await import("./connection.js");
const schema = await import("../schema.js");
const { createProject, computeActionableTicketIds } = await import("./projects.js");
const { clearFlagsCache: invalidateFlagsCache } = await import("./flags-cache.js");

const PROJECT = "p2102";
const ME = "claude-aiball-dev";
const HUMAN = "david";

const db = getDb();
createProject({ name: PROJECT });
// #2394 — the backlog is the project's work: the agent must lead it to have any.
const { upsertSubscription } = await import("./subscriptions.js");
upsertSubscription(ME, PROJECT, "owner");

let seq = 0;

/** An open, approved ticket whose last actor is the human → in the agent pool. */
function mkTicket(id: number) {
    db.insert(schema.tickets).values({
        id,
        project: PROJECT,
        displaySeq: id,
        title: `T${id}`,
        status: "approved",
        byAgent: HUMAN,
        lastActor: HUMAN,
        lastActorAt: nowIso(),
        createdAt: nowIso(),
    }).run();
}

/**
 * A relation message. The column names are counter-intuitive and worth stating:
 * `ticketId` holds the SOURCE and `sourceTicketId` holds the TARGET — the gate
 * reads them in that order, so a test that swapped them would pass for the
 * wrong reason.
 */
function relate(source: number, target: number, kind: "depends_on" | "blocks") {
    db.insert(schema.messages).values({
        id: 90000 + ++seq,
        ticketId: source,
        sourceTicketId: target,
        kind: "ticket_relation",
        status: "approved",
        byAgent: HUMAN,
        displaySeq: ++seq,
        createdAt: nowIso(),
        meta: JSON.stringify({ relation: { kind } }),
    }).run();
}

/** Close a ticket the way the product does: a lifecycle EVENT, not a column. */
function close(ticketId: number) {
    db.insert(schema.messages).values({
        id: 90000 + ++seq,
        ticketId,
        kind: "ticket_closed",
        status: "approved",
        byAgent: HUMAN,
        displaySeq: ++seq,
        createdAt: nowIso(),
    }).run();
    invalidateFlagsCache();
}

const actionable = () => computeActionableTicketIds(ME).actionableIds;
const gated = () => computeActionableTicketIds(ME).gatedByBlockerIds;

/**
 * #2102 — the property the scoping must never break: asking about ONE ticket
 * gives the same answer as computing the whole board and looking that ticket
 * up. Checked on all three sets, because a ticket wrongly absent from
 * `actionableIds` disappears from a queue while one wrongly present resurrects
 * work that was gated — both silent.
 */
function assertScopedMatchesFull(ids: number[], label: string) {
    const full = computeActionableTicketIds(ME);
    for (const id of ids) {
        const one = computeActionableTicketIds(ME, [id]);
        assert.equal(one.actionableIds.has(id), full.actionableIds.has(id), `${label}: actionable #${id}`);
        assert.equal(one.openIds.has(id), full.openIds.has(id), `${label}: open #${id}`);
        assert.equal(one.gatedByBlockerIds.has(id), full.gatedByBlockerIds.has(id), `${label}: gated #${id}`);
    }
    // And a multi-id bucket must agree with the same board.
    const many = computeActionableTicketIds(ME, ids);
    for (const id of ids) {
        assert.equal(many.actionableIds.has(id), full.actionableIds.has(id), `${label}: bucket actionable #${id}`);
    }
    assert.equal(
        [...many.actionableIds].every((id) => ids.includes(id)),
        true,
        `${label}: a scoped answer must not carry ids nobody asked about`,
    );
}

// 1 depends_on 2 ; 3 blocks 4 ; 5 stands alone.
mkTicket(1); mkTicket(2); mkTicket(3); mkTicket(4); mkTicket(5);
relate(1, 2, "depends_on");
relate(3, 4, "blocks");

test("a ticket depending on an OPEN blocker is not actionable", () => {
    assert.equal(actionable().has(1), false, "#1 depends on open #2");
    assert.equal(gated().has(1), true, "and it is reported as blocker-gated");
});

test("the blocker itself stays actionable", () => {
    // The gate suppresses the dependent, never the thing it waits on —
    // otherwise the work that would unblock the chain leaves the queue too.
    assert.equal(actionable().has(2), true);
});

test("`blocks` gates the TARGET, not the source", () => {
    // The two kinds read in opposite directions; getting this backwards would
    // gate exactly the wrong half of every pair.
    assert.equal(actionable().has(4), false, "#3 blocks #4, so #4 waits");
    assert.equal(actionable().has(3), true, "#3 itself is free to move");
});

test("an unrelated ticket is untouched by anyone's relations", () => {
    assert.equal(actionable().has(5), true);
});

test("scoped answer === full answer, while the gates are ON", () => {
    // The hard direction: #1 and #4 are gated by blockers that are NOT in the
    // requested bucket, so the scope has to have pulled them in on its own.
    assertScopedMatchesFull([1, 2, 3, 4, 5], "gated state");
});

test("closing the blocker frees the dependent — the write-on-X-changes-Y case", () => {
    // THE invariant for #2102: a write on #2 changes the answer for #1. Any
    // bucket that contains only the written ticket gets this wrong, which is
    // why the scope has to carry the dependents.
    assert.equal(actionable().has(1), false, "precondition: still gated");
    close(2);
    assert.equal(actionable().has(1), true, "#1 must become actionable when #2 closes");
    assert.equal(gated().has(1), false, "and stop being reported as gated");
});

test("closing the blocker of a `blocks` pair frees its target too", () => {
    assert.equal(actionable().has(4), false, "precondition: still gated");
    close(3);
    assert.equal(actionable().has(4), true);
});

test("scoped answer === full answer, after the blockers closed", () => {
    assertScopedMatchesFull([1, 2, 3, 4, 5], "freed state");
});

after(() => {
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});

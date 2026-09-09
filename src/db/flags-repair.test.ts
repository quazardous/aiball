// #2165 — a write must leave the flags cache holding exactly what a cold
// rebuild would produce.
//
// The simulator (scripts/sim-work-order.ts) already established the SCOPE on
// the live corpus: repairing the written ticket plus its relation counterparts
// matched a full recomputation 138/138 times, where the written ticket alone
// matched 137/138 — the miss being a ticket that DISAPPEARS from a queue.
// What it could not exercise is the WIRING: a dozen call sites each have to
// name what they touched, and a single one that forgets hands every reader a
// stale cache with no symptom for five seconds.
//
// So these tests go through the real write APIs, one per KIND of write, and
// compare the repaired cache against a rebuilt one. `theHarnessCanFail` is the
// control: it performs the same write behind the API's back and asserts the
// comparison DOES trip, so a green run here is not a green run of nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2165-"));

const { getDb, nowIso } = await import("./connection.js");
type Message = import("./connection.js").Message;
const schema = await import("../schema.js");
const { createProject, computeActionableTicketIds, decisionGateByTicket } = await import("./projects.js");
const { resetFlagsCacheForTests } = await import("./flags-cache.js");
const {
    insertMessage, updateMessageStatus, editMessage, deleteComment, moveTicket,
    promoteMessageToDecision, removeMessageDecision,
} = await import("./messages.js");
const { setTicketClaim, setTicketAssignment, releaseTicketClaim } = await import("./tickets.js");

const PROJECT = "p2165";
const OTHER_PROJECT = "p2165-elsewhere";
const ME = "claude-aiball-dev";
const PEER = "claude-aiball-win";
const HUMAN = "david";
/** Anonymous is a cache key of its own, and the one nobody thinks to check. */
const CONSUMERS: (string | undefined)[] = [ME, PEER, undefined];

const db = getDb();
createProject({ name: PROJECT });
createProject({ name: OTHER_PROJECT });

let seq = 0;

/** An open, approved ticket whose last actor is the human → in the agent pool. */
function mkTicket(id: number, project = PROJECT) {
    db.insert(schema.tickets).values({
        id, project, displaySeq: id, title: `T${id}`, status: "approved",
        byAgent: HUMAN, lastActor: HUMAN, lastActorAt: nowIso(), createdAt: nowIso(),
    }).run();
}

/** `ticketId` holds the SOURCE and `sourceTicketId` the TARGET — not a typo. */
function relate(source: number, target: number, kind: "depends_on" | "blocks") {
    db.insert(schema.messages).values({
        id: 90000 + ++seq, ticketId: source, sourceTicketId: target,
        kind: "ticket_relation", status: "approved", byAgent: HUMAN,
        displaySeq: ++seq, createdAt: nowIso(),
        meta: JSON.stringify({ relation: { kind } }),
    }).run();
}

/**
 * Posting leaves a message `pending` moderation, and every gate in here reads
 * `approved` only — an un-approved close is invisible to the lifecycle replay.
 * So the fixture moderates, through the real API, exactly as the daemon does.
 */
function approved(m: Message): Message {
    if (m.status === "approved") return m;
    return updateMessageStatus(m.id, "approved", "auto", null, m.kind) ?? m;
}

const comment = (ticketId: number, by: string, body = "text") =>
    approved(insertMessage({ project: PROJECT, kind: "comment_added", ticket_id: ticketId, by_agent: by, body }));

const closeTicket = (ticketId: number, by = HUMAN) =>
    approved(insertMessage({ project: PROJECT, kind: "ticket_closed", ticket_id: ticketId, by_agent: by }));

// One ticket per test rather than a shared board: these tests assert that a
// write MOVED something, and a ticket another test already closed or gated
// would make that assertion pass or fail for reasons of its own.
let nextTicket = 100;
function freshTicket(): number {
    const id = nextTicket++;
    mkTicket(id);
    return id;
}
mkTicket(900, OTHER_PROJECT);

interface Snap { open: number[]; actionable: number[]; gated: number[] }
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
const snap = (c: string | undefined): Snap => {
    const s = computeActionableTicketIds(c);
    return { open: sorted(s.openIds), actionable: sorted(s.actionableIds), gated: sorted(s.gatedByBlockerIds) };
};
const gateSnap = () => [...decisionGateByTicket()].sort((a, b) => a[0] - b[0]);

/** Fill every cache key, and hand back what they hold. */
function warm(): { flags: Snap[]; gate: [number, boolean][] } {
    resetFlagsCacheForTests();
    return { flags: CONSUMERS.map(snap), gate: gateSnap() };
}

/**
 * The property. Read the cache the write repaired, then throw it away and
 * rebuild from scratch; the two must be identical for every consumer AND for
 * the cross-consumer decision gate. `changed` guards against the assertion
 * passing because the write moved nothing at all.
 */
function assertRepaired(before: { flags: Snap[]; gate: [number, boolean][] }, label: string, expectChange = true) {
    const repaired = CONSUMERS.map(snap);
    const repairedGate = gateSnap();
    resetFlagsCacheForTests();
    const rebuilt = CONSUMERS.map(snap);
    const rebuiltGate = gateSnap();

    assert.deepEqual(repaired, rebuilt, `${label}: repaired flags != rebuilt`);
    assert.deepEqual(repairedGate, rebuiltGate, `${label}: repaired decision gate != rebuilt`);
    if (expectChange) {
        const moved = JSON.stringify([before.flags, before.gate]) !== JSON.stringify([rebuilt, rebuiltGate]);
        assert.ok(moved, `${label}: the write changed nothing, so the comparison proved nothing`);
    }
}

test("a new comment — the hot path, every reply goes through it", () => {
    const t = freshTicket();
    const before = warm();
    comment(t, PEER);
    assertRepaired(before, "comment_added");
});

test("closing a ticket takes it out of open AND actionable", () => {
    const t = freshTicket();
    const before = warm();
    closeTicket(t);
    assertRepaired(before, "ticket_closed");
});

test("closing a BLOCKER frees the dependent the write never named", () => {
    // The reason the repair scope reaches past the written ticket. The write
    // touches the blocker; the ticket whose state moves is the dependent, and
    // no call site can name it.
    const dependent = freshTicket();
    const blocker = freshTicket();
    relate(dependent, blocker, "depends_on");
    const before = warm();
    assert.ok(before.flags[0].gated.includes(dependent), "precondition: gated");

    closeTicket(blocker);

    assertRepaired(before, "blocker closed");
    assert.ok(
        !computeActionableTicketIds(ME).gatedByBlockerIds.has(dependent),
        "the dependent is free now",
    );
});

test("a claim by someone else drops the ticket from MY pool but not theirs", () => {
    const t = freshTicket();
    const before = warm();
    setTicketClaim(t, PEER);
    assertRepaired(before, "setTicketClaim");
    assert.ok(!computeActionableTicketIds(ME).actionableIds.has(t), "gone from mine");
    assert.ok(computeActionableTicketIds(PEER).actionableIds.has(t), "still in theirs");
});

test("releasing that claim puts it back", () => {
    const t = freshTicket();
    setTicketClaim(t, PEER);
    const before = warm();
    releaseTicketClaim(t);
    assertRepaired(before, "releaseTicketClaim");
});

test("an assignment is a persistent hold, and repairs the same way", () => {
    const t = freshTicket();
    const before = warm();
    setTicketAssignment(t, PEER, HUMAN);
    assertRepaired(before, "setTicketAssignment");
});

test("promoting a comment to a pending plan gates its ticket", () => {
    const t = freshTicket();
    const m = comment(t, ME, "here is how I would do it");
    const before = warm();
    promoteMessageToDecision(m.id, "plan", undefined, ME);
    assertRepaired(before, "promoteMessageToDecision");
});

test("removing that decision DELETES the key rather than leaving its old true", () => {
    // The decision gate is a map where an absent key reads as "not gated", so a
    // repair that only ever `set`s would keep a removed decision gating forever.
    const t = freshTicket();
    const m = comment(t, ME, "a plan");
    promoteMessageToDecision(m.id, "plan", undefined, ME);
    const before = warm();
    assert.equal(decisionGateByTicket().get(t), true, "precondition: gated");

    removeMessageDecision(m.id);

    assertRepaired(before, "removeMessageDecision");
    assert.notEqual(decisionGateByTicket().get(t), true, "and the gate is really gone");
});

test("moderating a pending close is what actually shuts the ticket", () => {
    // A status flip on a plain comment moves nothing — `last_actor` is a
    // denormalised column the flip does not touch. The flip that DOES move a
    // gate is the one on a lifecycle event: the replay counts `approved` only,
    // so the ticket leaves `open` at moderation time, not at posting time.
    const t = freshTicket();
    const m = insertMessage({ project: PROJECT, kind: "ticket_closed", ticket_id: t, by_agent: ME });
    const before = warm();
    assert.ok(before.flags[0].open.includes(t), "precondition: still open while pending");

    updateMessageStatus(m.id, "approved", "human", null, "ticket_closed");

    assertRepaired(before, "updateMessageStatus");
    assert.ok(!computeActionableTicketIds(ME).openIds.has(t), "closed now");
});

test("an edit repairs even though it usually moves nothing", () => {
    const t = freshTicket();
    const m = comment(t, PEER, "before");
    const before = warm();
    editMessage(m.id, { body: "after" });
    // An edit rarely moves a gate; what must hold is that the cache is not left
    // holding something a rebuild disagrees with.
    assertRepaired(before, "editMessage", false);
});

test("deleting a comment", () => {
    const t = freshTicket();
    const m = comment(t, PEER, "to be deleted");
    const before = warm();
    deleteComment(m.id, HUMAN);
    assertRepaired(before, "deleteComment", false);
});

test("a project move clears rather than repairs, and stays correct", () => {
    // Per-agent work filters narrow the pool by project, so a move's blast
    // radius is not enumerable; the fallback is a full clear.
    const t = freshTicket();
    const before = warm();
    moveTicket(t, OTHER_PROJECT, HUMAN);
    assertRepaired(before, "moveTicket", false);
});

test("the harness can fail — a write behind the API's back is caught", () => {
    // The control. Everything above compares a repaired cache to a rebuilt one;
    // if that comparison could not trip, a green run would mean nothing. Here
    // the same close is written straight to the table, so no call site names
    // it, and the assertion must fire.
    const t = freshTicket();
    const before = warm();
    db.insert(schema.messages).values({
        id: 90000 + ++seq, ticketId: t, kind: "ticket_closed", status: "approved",
        byAgent: HUMAN, displaySeq: ++seq, createdAt: nowIso(),
    }).run();
    assert.throws(() => assertRepaired(before, "unwired write"), /repaired flags != rebuilt/);
});

after(() => {
    rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
});

/**
 * #2308 — the transition table is the one place a decision's behaviour is
 * defined. What must hold:
 * - every kind has its row, and the two families split the kinds between them;
 * - the gate replay follows a truth table written HERE, by hand. A test that
 *   read its expectations back from the table would prove nothing;
 * - posting honours `allowedOn`, each `then` verb maps to its kind, and the
 *   post-time effects sit where the table says;
 * - the matrix in docs/TICKET_LIFECYCLE.md is exactly what the table renders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-2308-"));
process.env.AIBALL_SOCK = "";

const t = await import("./ticket-transitions.js");
const { computeDecisionGate } = await import("./db/decision-gate.js");
const { CLOSING_DECISION_KINDS, WAITING_DECISION_KINDS } = await import("./decisions.js");
const { validateNewMessage } = await import("./messages.js");
const { buildInboxRow } = await import("./api/inbox-row.js");
const { emptyAgg } = await import("./db/inbox-agg.js");

type Kind = typeof t.DECISION_KINDS[number];
type Scenario =
    | "pending"
    | "pending, then someone else comments"
    | "pending, then the proposer comments"
    | "accepted"
    | "accepted, then someone else comments"
    | "rejected";

// Is the ticket gated at the end of each scenario? Written by hand; typed as a
// Record over the kinds, so a new kind does not typecheck until its expected
// behaviour is written down here.
const EXPECTED: Record<Kind, Record<Scenario, boolean>> = {
    plan: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": false, "accepted, then someone else comments": false, "rejected": false,
    },
    resolution: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": true, "accepted, then someone else comments": true, "rejected": false,
    },
    wontfix: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": true, "accepted, then someone else comments": true, "rejected": false,
    },
    escalation: {
        "pending": true, "pending, then someone else comments": false, "pending, then the proposer comments": true,
        "accepted": false, "accepted, then someone else comments": false, "rejected": false,
    },
};

const decided = (kind: string, status: string) => ({
    ticketId: 1, kind: "comment_added", status: "approved",
    meta: JSON.stringify({ decision: { kind, status } }), byAgent: "agent",
});
const plain = (by: string) => ({ ticketId: 1, kind: "comment_added", status: "approved", meta: null, byAgent: by });

function scenario(kind: string, s: Scenario) {
    switch (s) {
        case "pending": return [decided(kind, "pending")];
        case "pending, then someone else comments": return [decided(kind, "pending"), plain("david")];
        case "pending, then the proposer comments": return [decided(kind, "pending"), plain("agent")];
        case "accepted": return [decided(kind, "accepted")];
        case "accepted, then someone else comments": return [decided(kind, "accepted"), plain("david")];
        case "rejected": return [decided(kind, "pending"), decided(kind, "rejected")];
    }
}

test("every decision kind has its row and its expected behaviour, and the two families split the kinds", () => {
    assert.deepEqual(Object.keys(t.DECISION_GESTURES), [...t.DECISION_KINDS]);
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...t.DECISION_KINDS].sort());
    const closing = [...CLOSING_DECISION_KINDS];
    const waiting = [...WAITING_DECISION_KINDS];
    assert.deepEqual([...closing, ...waiting].sort(), [...t.DECISION_KINDS].sort());
    assert.equal(closing.filter((k) => waiting.includes(k)).length, 0);
});

test("the gate replay follows the truth table, kind by kind and scenario by scenario", () => {
    for (const kind of t.DECISION_KINDS) {
        for (const [s, gated] of Object.entries(EXPECTED[kind]) as [Scenario, boolean][]) {
            assert.equal(computeDecisionGate(scenario(kind, s), () => false).get(1), gated, `${kind}: ${s}`);
        }
    }
    assert.equal(t.gateEffect("nope", "pending"), null, "an unknown kind is inert");
    assert.equal(t.gateEffect("plan", "weird"), null, "an unknown status is inert");
});

test("a decision is accepted where the table allows it and refused elsewhere, with the reason", () => {
    for (const kind of t.DECISION_KINDS) {
        const onComment = validateNewMessage({ project: "p", kind: "comment_added", ticket_id: 1, body: "b", decision_kind: kind });
        assert.ok(!("error" in onComment && /decision_kind/.test(String(onComment.error))), `${kind} on a comment`);
        const onTicket = validateNewMessage({ project: "p", kind: "ticket_created", title: "t", body: "b", decision_kind: kind });
        if (kind === "plan") {
            assert.ok(!("error" in onTicket), "a plan may ride on a new ticket");
        } else {
            assert.match(String((onTicket as { error?: string }).error), /decision_kind on ticket_created must be "plan"/, kind);
        }
    }
});

test("each then verb posts its kind, and only escalation acts when posted", () => {
    assert.equal(t.kindForVerb("resolved"), "resolution");
    assert.equal(t.kindForVerb("escalate"), "escalation");
    assert.equal(t.kindForVerb("close"), null);
    assert.deepEqual(t.verbsAllowedOn("ticket_created"), ["plan"]);
    assert.deepEqual(t.verbsAllowedOn("comment_added"), ["plan", "resolved", "wontfix", "escalate"]);
    for (const kind of t.DECISION_KINDS) {
        const { bumpPriority, broadcast } = t.DECISION_GESTURES[kind].onPost;
        assert.equal(bumpPriority, kind === "escalation", `${kind} priority bump`);
        assert.equal(broadcast, kind === "escalation", `${kind} broadcast`);
    }
});

test("the lifecycle doc's decision matrix is exactly what the table renders", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "TICKET_LIFECYCLE.md"), "utf8");
    assert.equal(t.withDecisionMatrix(doc), doc, "out of date — run: npx tsx scripts/gen-transition-matrix.ts");
});

test("close-time acceptance, the agent's pending list, rejection badges and attention order are as written here", () => {
    type BoolCol = "autoAcceptedOnClose" | "listedAsMyPending" | "surfacesRejection";
    const pick = (col: BoolCol) => t.DECISION_KINDS.filter((k) => t.DECISION_GESTURES[k][col]);
    assert.deepEqual(pick("autoAcceptedOnClose"), ["resolution"]);
    assert.deepEqual(pick("listedAsMyPending"), ["plan", "resolution"]);
    assert.deepEqual(pick("surfacesRejection"), ["plan", "resolution"]);
    assert.deepEqual(t.kindsByAttention(), ["escalation", "plan", "resolution", "wontfix"]);
    for (const k of t.DECISION_KINDS) assert.equal(t.DECISION_GESTURES[k].inboxFlag, `pending_${k}`);
    assert.equal(t.resolvesTicket("resolution", "accepted"), true);
    for (const [k, st] of [["resolution", "pending"], ["wontfix", "accepted"], ["plan", "accepted"]] as const) {
        assert.equal(t.resolvesTicket(k, st), false, `${k} ${st}`);
    }
});

type Agg = ReturnType<typeof emptyAgg>;
function rowWith(mutate: (agg: Agg) => void): Record<string, unknown> {
    const agg = emptyAgg();
    mutate(agg);
    const ctx = {
        byTicket: new Map([[7, agg]]), tagsMap: new Map(), unreadMap: new Map(), tokenUsageMap: new Map(),
        crossAgentHotFocus: new Set(), payloadIds: new Set(), nowStr: new Date().toISOString(),
    };
    const ticket = { id: 7, project: "p", kind: "ticket_created", status: "approved", title: "t", body: "", meta: null, created_at: "2026-01-01T00:00:00Z" };
    return buildInboxRow(ticket as never, ctx as never) as unknown as Record<string, unknown>;
}

test("the inbox row raises each kind's flag and points at the most urgent pending decision", () => {
    for (const kind of t.DECISION_KINDS) {
        const row = rowWith((agg) => { agg.decisions[kind].pending = true; agg.decisions[kind].latestId = 11; agg.lastSpeakerId = 11; });
        for (const other of t.DECISION_KINDS) {
            const flag = t.DECISION_GESTURES[other].inboxFlag;
            assert.equal(row[flag], other === kind, `${kind} pending → ${flag}`);
        }
        assert.equal(row.pending_decision_is_latest, true, kind);
    }
    const both = rowWith((agg) => {
        agg.decisions.plan.pending = true; agg.decisions.plan.latestId = 20;
        agg.decisions.escalation.pending = true; agg.decisions.escalation.latestId = 10;
        agg.lastSpeakerId = 10;
    });
    assert.equal(both.pending_decision_is_latest, true, "with a plan and an escalation pending, the row points at the escalation");
    const rejected = rowWith((agg) => { for (const k of t.DECISION_KINDS) agg.decisions[k].rejected = true; });
    assert.equal(rejected.latest_plan_rejected, true);
    assert.equal(rejected.latest_resolution_rejected, true);
    assert.equal("latest_wontfix_rejected" in rejected, false);
});

test("a decision filed with the ticket itself raises its flag too, and a closed ticket raises none", () => {
    const withTicketPlan = (closed: boolean) => {
        const agg = emptyAgg();
        agg.closed = closed;
        const ctx = {
            byTicket: new Map([[8, agg]]), tagsMap: new Map(), unreadMap: new Map(), tokenUsageMap: new Map(),
            crossAgentHotFocus: new Set(), payloadIds: new Set(), nowStr: new Date().toISOString(),
        };
        const ticket = {
            id: 8, project: "p", kind: "ticket_created", status: "approved", title: "t", body: "",
            meta: JSON.stringify({ decision: { kind: "plan", status: "pending" } }), created_at: "2026-01-01T00:00:00Z",
        };
        return buildInboxRow(ticket as never, ctx as never) as unknown as Record<string, unknown>;
    };
    assert.equal(withTicketPlan(false).pending_plan, true);
    assert.equal(withTicketPlan(false).pending_decision_is_latest, true);
    assert.equal(withTicketPlan(true).pending_plan, false);
});

// The row tests above set the aggregate by hand; this one goes through the real
// fold over stored comments, so a track the fold stops updating is caught.
test("the inbox fold tracks each kind's latest decision from the stored comments", async () => {
    const { getDb, nowIso } = await import("./db/connection.js");
    const schema = await import("./schema.js");
    const { createProject } = await import("./db/projects.js");
    const { buildInboxAgg } = await import("./db/inbox-agg.js");
    const db = getDb();
    createProject({ name: "p2308" });
    let id = 90000;
    const ticket = () => {
        const tid = ++id;
        db.insert(schema.tickets).values({
            id: tid, project: "p2308", displaySeq: tid, title: `T${tid}`, status: "approved",
            byAgent: "david", lastActor: "david", lastActorAt: nowIso(), createdAt: nowIso(),
        }).run();
        return tid;
    };
    const decision = (ticketId: number, kind: string, status: string) => {
        const mid = ++id;
        db.insert(schema.messages).values({
            id: mid, ticketId, kind: "comment_added", status: "approved", body: "b",
            meta: JSON.stringify({ decision: { kind, status } }), byAgent: "agent", displaySeq: mid, createdAt: nowIso(),
        }).run();
        return mid;
    };
    const cases = t.DECISION_KINDS.map((kind) => {
        const rejectedLast = ticket();
        decision(rejectedLast, kind, "accepted");
        const rejectedId = decision(rejectedLast, kind, "rejected");
        const pendingLast = ticket();
        decision(pendingLast, kind, "rejected");
        const pendingId = decision(pendingLast, kind, "pending");
        const accepted = ticket();
        decision(accepted, kind, "accepted");
        return { kind, rejectedLast, rejectedId, pendingLast, pendingId, accepted };
    });
    const agg = buildInboxAgg("p2308");
    for (const c of cases) {
        assert.deepEqual(agg.get(c.rejectedLast)!.decisions[c.kind],
            { latestId: c.rejectedId, pending: false, rejected: true }, `${c.kind}: rejected last`);
        assert.deepEqual(agg.get(c.pendingLast)!.decisions[c.kind],
            { latestId: c.pendingId, pending: true, rejected: false }, `${c.kind}: a newer proposal replaces the rejection`);
        assert.equal(agg.get(c.accepted)!.resolved, c.kind === "resolution", `${c.kind}: accepted resolves the ticket?`);
        for (const other of t.DECISION_KINDS.filter((k) => k !== c.kind)) {
            assert.equal(agg.get(c.rejectedLast)!.decisions[other].latestId, 0, `${c.kind} leaves ${other} untouched`);
        }
    }
});

// --- then: continue (a step): the pure rules first, then the fold ---------------

test("then: continue is a reply gesture, not a decision, and a step is read tolerantly", () => {
    assert.equal(t.kindForVerb(t.STEP_VERB), null);
    assert.deepEqual(Object.keys(t.REPLY_GESTURES), ["comment_only", "continue"]);
    assert.equal(t.isStepMeta(JSON.stringify({ step: true, summary_until: "s" })), true);
    for (const m of [null, undefined, "", "not json", "null", "{}", JSON.stringify({ step: "yes" })]) {
        assert.equal(t.isStepMeta(m), false, String(m));
    }
    const stepMeta = JSON.stringify({ step: true });
    assert.equal(t.movesLastActor("comment_added", stepMeta), false);
    assert.equal(t.movesLastActor("comment_added", null), true);
    assert.equal(t.movesLastActor("ticket_closed", stepMeta), true, "only a comment can be a step");
});

test("whose turn it is after a step, replayed without a database", async () => {
    const { replayLastActor, isExcludedForConsumer } = await import("./db/last-actor-gate.js");
    const at = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
    const ev = (n: number, by: string, meta: object | null = null) =>
        ({ kind: "comment_added", byAgent: by, createdAt: at(n), meta: meta ? JSON.stringify(meta) : null });
    const step = { step: true };
    const planAcceptedByDavid = { decision: { kind: "plan", status: "accepted", decided_by: "david", decided_at: at(2) } };
    // Is the ticket out of the agent's pool at the end? Written by hand.
    const EXPECTED_OUT: [string, ReturnType<typeof ev>[], boolean][] = [
        ["the agent comments", [ev(1, "agent")], true],
        ["the agent posts a step", [ev(1, "agent", step)], false],
        ["david accepts the plan, the agent posts two steps", [ev(1, "agent", planAcceptedByDavid), ev(3, "agent", step), ev(4, "agent", step)], false],
        ["the agent asked a question, then posts a step", [ev(1, "agent"), ev(2, "agent", step)], true],
        ["the agent posts a step, david answers", [ev(1, "agent", step), ev(2, "david")], false],
        ["the agent posts a step, then a comment", [ev(1, "agent", step), ev(2, "agent")], true],
    ];
    for (const [name, events, out] of EXPECTED_OUT) {
        const { actor } = replayLastActor({ actor: "david", at: at(0) }, events);
        assert.equal(isExcludedForConsumer(actor, true, "agent"), out, name);
    }
});

test("a step by the proposer leaves the proposal pending", () => {
    const events = [decided("plan", "pending"), { ...plain("agent"), meta: JSON.stringify({ step: true }) }];
    assert.equal(computeDecisionGate(events, () => false).get(1), true);
});

test("only the agent holding the ticket may post a step", () => {
    const base = { author: "agent", ticketStatus: "approved", assignee: null, claimant: "agent", claimLive: true };
    assert.equal(t.stepRefusal(base), null, "its live claim");
    assert.equal(t.stepRefusal({ ...base, claimant: null, claimLive: false, assignee: "agent" }), null, "its assignment");
    assert.match(t.stepRefusal({ ...base, claimLive: false }) ?? "", /claim it first/, "its claim expired");
    assert.match(t.stepRefusal({ ...base, claimant: null, claimLive: false }) ?? "", /claim it first/, "nobody holds it");
    assert.match(t.stepRefusal({ ...base, claimant: "other" }) ?? "", /held by other/, "another agent's claim");
    assert.match(t.stepRefusal({ ...base, claimant: null, claimLive: false, assignee: "other" }) ?? "", /held by other/, "assigned to another");
    assert.match(t.stepRefusal({ ...base, ticketStatus: "pending" }) ?? "", /approved ticket/, "still in moderation");
});

test("a step is flagged stalled only while it is the latest word and old enough", () => {
    const now = Date.parse("2026-01-02T12:00:00Z");
    assert.equal(t.isStepStalled("2026-01-01T11:00:00Z", true, now, 24), true);
    assert.equal(t.isStepStalled("2026-01-02T11:00:00Z", true, now, 24), false, "too recent");
    assert.equal(t.isStepStalled("2026-01-01T11:00:00Z", false, now, 24), false, "something followed");
    assert.equal(t.isStepStalled("2026-01-01T11:00:00Z", true, now, 0), false, "0 turns it off");
    assert.equal(t.isStepStalled(null, true, now, 24), false, "no step");
});

test("the fold tracks the latest step and the row flags it once nothing followed", async () => {
    const { getDb, nowIso } = await import("./db/connection.js");
    const schema = await import("./schema.js");
    const { createProject } = await import("./db/projects.js");
    const { buildInboxAgg } = await import("./db/inbox-agg.js");
    const db = getDb();
    createProject({ name: "p2308-step" });
    const old = "2026-01-01T00:00:00.000Z";
    let id = 95000;
    const mkTicket = () => {
        const tid = ++id;
        db.insert(schema.tickets).values({
            id: tid, project: "p2308-step", displaySeq: tid, title: `S${tid}`, status: "approved",
            byAgent: "david", lastActor: "david", lastActorAt: nowIso(), createdAt: old,
        }).run();
        return tid;
    };
    const say = (ticketId: number, by: string, meta: object | null) => {
        const mid = ++id;
        db.insert(schema.messages).values({
            id: mid, ticketId, kind: "comment_added", status: "approved", body: "b",
            meta: meta ? JSON.stringify(meta) : null, byAgent: by, displaySeq: mid, createdAt: old,
        }).run();
        return mid;
    };
    const quiet = mkTicket();
    const stepId = say(quiet, "agent", { step: true });
    const answered = mkTicket();
    say(answered, "agent", { step: true });
    say(answered, "david", null);
    const agg = buildInboxAgg("p2308-step");
    assert.equal(agg.get(quiet)!.lastStepId, stepId);
    assert.equal(agg.get(quiet)!.lastStepAt, old);
    const row = (tid: number, hours: number) => buildInboxRow(
        { id: tid, project: "p2308-step", kind: "ticket_created", status: "approved", title: "t", body: "", meta: null, created_at: old } as never,
        {
            byTicket: agg, tagsMap: new Map(), unreadMap: new Map(), tokenUsageMap: new Map(),
            crossAgentHotFocus: new Set(), payloadIds: new Set(), nowStr: new Date().toISOString(), stepStaleHours: () => hours,
        } as never,
    ) as unknown as Record<string, unknown>;
    assert.equal(row(quiet, 24).stalled_step, true);
    assert.equal(row(answered, 24).stalled_step, false, "david answered after the step");
    assert.equal(row(quiet, 0).stalled_step, false, "0 turns the flag off");
});

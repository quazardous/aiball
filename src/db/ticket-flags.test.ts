// #791 Phase 1 — pure tests for computeTicketFlags. The fn takes a row
// + a precomputed context; output is deterministic, no I/O. The matrix
// below covers every combination of (closed, postponed, actionable,
// last_actor=me, decision-gated, cooled) that the route handler can
// hand it. Adding a new flag = add a row here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTicketFlags, type TicketFlagsContext, type TicketFlagsRow } from "./ticket-flags.js";

const NOW_MS = Date.parse("2026-06-04T14:00:00Z");

function buildCtx(overrides: Partial<TicketFlagsContext> = {}): TicketFlagsContext {
    return {
        consumerId: "me",
        unreadIds: new Set(),
        actionableIds: new Set(),
        openIds: new Set(),
        lastActorMeIds: new Set(),
        decisionGated: new Map(),
        cooledWakeAt: new Map(),
        ownClaimIds: new Set(),
        assignedToMeIds: new Set(),
        crossAgentHot: new Set(),
        lastActorByTicket: new Map(),
        closedSet: new Set(),
        isClaimable: () => false,
        nowMs: NOW_MS,
        cooldownSec: 3600,
        ...overrides,
    };
}

function buildRow(overrides: Partial<TicketFlagsRow> = {}): TicketFlagsRow {
    return { id: 1, project: "p", assignee: null, postponed_until: null, ...overrides };
}

test("tier 1 — actionable, ball in my court", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({ actionableIds: new Set([1]) }),
    );
    assert.equal(flags.backlog_tier, 1);
    assert.equal(flags.actionable, true);
    assert.equal(flags.gated_by_decision, false);
});

test("tier 2 — last actor=me, no decision, ball in their court", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({ lastActorMeIds: new Set([1]) }),
    );
    assert.equal(flags.backlog_tier, 2);
    assert.equal(flags.actionable, false);
});

test("tier 0 — last actor=me but pending decision", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            lastActorMeIds: new Set([1]),
            decisionGated: new Map([[1, true]]),
        }),
    );
    assert.equal(flags.backlog_tier, 0);
    assert.equal(flags.gated_by_decision, true);
});

test("tier 0 — closed", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            actionableIds: new Set([1]),
            closedSet: new Set([1]),
        }),
    );
    assert.equal(flags.backlog_tier, 0);
});

test("tier 0 — snoozed (postponed_until in the future)", () => {
    const flags = computeTicketFlags(
        buildRow({ postponed_until: new Date(NOW_MS + 86_400_000).toISOString() }),
        buildCtx({ actionableIds: new Set([1]) }),
    );
    assert.equal(flags.backlog_tier, 0);
});

test("tier 1 — postponed_until in the past doesn't snooze", () => {
    const flags = computeTicketFlags(
        buildRow({ postponed_until: new Date(NOW_MS - 86_400_000).toISOString() }),
        buildCtx({ actionableIds: new Set([1]) }),
    );
    assert.equal(flags.backlog_tier, 1);
});

test("tier 0 — neither actionable nor last actor=me", () => {
    const flags = computeTicketFlags(buildRow(), buildCtx());
    assert.equal(flags.backlog_tier, 0);
    assert.equal(flags.actionable, false);
    assert.equal(flags.gated_by_decision, false);
});

test("cooldown — set when wake_at + cooldown is in the future", () => {
    const wakeAt = new Date(NOW_MS - 600_000).toISOString(); // 10 min ago
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            actionableIds: new Set([1]),
            cooledWakeAt: new Map([[1, wakeAt]]),
            cooldownSec: 3600, // 1h, so 50 min remaining
        }),
    );
    assert.equal(flags.backlog_tier, 1);
    assert.ok(flags.backlog_cooled_until !== null);
    assert.ok(Date.parse(flags.backlog_cooled_until!) > NOW_MS);
});

test("cooldown — null when wake_at + cooldown is in the past", () => {
    const wakeAt = new Date(NOW_MS - 2 * 3600_000).toISOString(); // 2h ago
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            actionableIds: new Set([1]),
            cooledWakeAt: new Map([[1, wakeAt]]),
            cooldownSec: 3600,
        }),
    );
    assert.equal(flags.backlog_cooled_until, null);
});

test("cooldown — null when cooldownSec is 0 (disabled)", () => {
    const wakeAt = new Date(NOW_MS - 600_000).toISOString();
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            actionableIds: new Set([1]),
            cooledWakeAt: new Map([[1, wakeAt]]),
            cooldownSec: 0,
        }),
    );
    assert.equal(flags.backlog_cooled_until, null);
});

test("cooldown — null on tier 0 (no point surfacing if not in backlog)", () => {
    const wakeAt = new Date(NOW_MS - 600_000).toISOString();
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            closedSet: new Set([1]),
            cooledWakeAt: new Map([[1, wakeAt]]),
        }),
    );
    assert.equal(flags.backlog_tier, 0);
    assert.equal(flags.backlog_cooled_until, null);
});

test("unread — surfaced from unreadIds", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({ unreadIds: new Set([1]) }),
    );
    assert.equal(flags.unread, true);
});

test("claimable — delegates to ctx.isClaimable", () => {
    let called = false;
    const flags = computeTicketFlags(
        buildRow({ project: "p", assignee: "x" }),
        buildCtx({
            isClaimable: (id, proj, assignee) => {
                called = true;
                assert.equal(id, 1);
                assert.equal(proj, "p");
                assert.equal(assignee, "x");
                return true;
            },
        }),
    );
    assert.equal(called, true);
    assert.equal(flags.claimable, true);
});

test("is_claim — true when ticket is in ownClaimIds", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({ ownClaimIds: new Set([1]) }),
    );
    assert.equal(flags.is_claim, true);
});

test("hot — true when ticket is in crossAgentHot", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({ crossAgentHot: new Set([1]) }),
    );
    assert.equal(flags.hot, true);
});

test("last_actor — surfaced from lastActorByTicket", () => {
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            lastActorByTicket: new Map([[1, { actor: "david", at: "2026-06-01T00:00:00Z" }]]),
        }),
    );
    assert.equal(flags.last_actor, "david");
    assert.equal(flags.last_actor_at, "2026-06-01T00:00:00Z");
});

test("last_actor — null when not in lastActorByTicket", () => {
    const flags = computeTicketFlags(buildRow(), buildCtx());
    assert.equal(flags.last_actor, null);
    assert.equal(flags.last_actor_at, null);
});

test("actionable wins over lastActorMe for tier (impossible state, but checked)", () => {
    // In practice the daemon guarantees these sets are disjoint, but the
    // pure fn doesn't assume it. Tier 1 wins (actionable is the stricter
    // claim).
    const flags = computeTicketFlags(
        buildRow(),
        buildCtx({
            actionableIds: new Set([1]),
            lastActorMeIds: new Set([1]),
        }),
    );
    assert.equal(flags.backlog_tier, 1);
});

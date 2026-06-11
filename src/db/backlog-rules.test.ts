// #886 — BacklogRules engine pure tests.
//
// 1. Each rule fires on the right item.
// 2. Each rule excludes from the targets it declares.
// 3. The engine dispatch composes rules correctly (OR over active rules).
//
// Run: `npx tsx --test src/db/backlog-rules.test.ts`
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    BacklogRules,
    DEFAULT_RULES,
    defaultBacklogRules,
    type BacklogRulesCtx,
    type RuleItem,
    type Target,
} from "./backlog-rules.js";

function mkCtx(opts: Partial<BacklogRulesCtx> = {}): BacklogRulesCtx {
    return {
        consumerId: opts.consumerId ?? "me",
        nowMs: opts.nowMs ?? Date.now(),
        closedIds: opts.closedIds ?? new Set(),
        snoozedIds: opts.snoozedIds ?? new Set(),
        claimedByOtherIds: opts.claimedByOtherIds ?? new Set(),
    };
}

function findRule(name: string) {
    const r = DEFAULT_RULES.find((r) => r.name === name);
    if (!r) throw new Error(`rule not found: ${name}`);
    return r;
}

// =====================================================================
//  Rules individuelles
// =====================================================================

test("closed rule fires when ticketId in closedIds", () => {
    const rule = findRule("closed");
    const ctx = mkCtx({ closedIds: new Set([42]) });
    assert.equal(rule.when(ctx, { ticketId: 42 }), true);
    assert.equal(rule.when(ctx, { ticketId: 43 }), false);
});

test("closed rule excludes backlog-tier + actionable-pool + hot-tier, NOT unread-*", () => {
    // #805 — closed reste visible dans unread-list/unread-count
    // jusqu'au prune-on-MCP-consult.
    const rule = findRule("closed");
    assert.equal(rule.excludesFrom.has("backlog-tier"), true);
    assert.equal(rule.excludesFrom.has("actionable-pool"), true);
    assert.equal(rule.excludesFrom.has("hot-tier"), true);
    assert.equal(rule.excludesFrom.has("unread-list"), false);
    assert.equal(rule.excludesFrom.has("unread-count"), false);
});

test("snoozed rule fires when ticketId in snoozedIds", () => {
    const rule = findRule("snoozed");
    const ctx = mkCtx({ snoozedIds: new Set([7]) });
    assert.equal(rule.when(ctx, { ticketId: 7 }), true);
    assert.equal(rule.when(ctx, { ticketId: 8 }), false);
});

test("snoozed rule excludes from ALL targets", () => {
    const rule = findRule("snoozed");
    const all: Target[] = [
        "unread-list", "unread-count", "fifo-wake",
        "backlog-tier", "actionable-pool", "hot-tier",
    ];
    for (const t of all) assert.equal(rule.excludesFrom.has(t), true, t);
});

test("self-authored-ticket rule fires when ticketByAgent === consumer (ticket-event)", () => {
    const rule = findRule("self-authored-ticket");
    const ctx = mkCtx({ consumerId: "alice" });
    // ticket-event = item built via ticketRowToRuleItem ⇒ commentByAgent undefined
    assert.equal(rule.when(ctx, { ticketId: 1, ticketByAgent: "alice" }), true);
    assert.equal(rule.when(ctx, { ticketId: 1, ticketByAgent: "bob" }), false);
    assert.equal(rule.when(ctx, { ticketId: 1, ticketByAgent: null }), false);
});

test("#918 self-authored-ticket does NOT fire on a comment by another agent on my ticket", () => {
    const rule = findRule("self-authored-ticket");
    const ctx = mkCtx({ consumerId: "alice" });
    // comment-event = item built via messageRowToRuleItem ⇒ commentByAgent set.
    // ticketByAgent = parent ticket's author (= me). Without the comment scope,
    // this would over-fire and silence wake CTAs for comments others post on
    // my tickets — that's the #908/#918 bug.
    assert.equal(
        rule.when(ctx, { ticketId: 1, ticketByAgent: "alice", commentByAgent: "bob" }),
        false,
        "comment by bob on alice's ticket must NOT be excluded from fifo-wake",
    );
    // A self-comment on my own ticket is covered by self-authored-comment,
    // not by self-authored-ticket. So this rule also returns false here.
    assert.equal(
        rule.when(ctx, { ticketId: 1, ticketByAgent: "alice", commentByAgent: "alice" }),
        false,
    );
});

test("self-authored-comment rule fires when commentByAgent === consumer", () => {
    const rule = findRule("self-authored-comment");
    const ctx = mkCtx({ consumerId: "alice" });
    assert.equal(rule.when(ctx, { ticketId: 1, commentByAgent: "alice" }), true);
    assert.equal(rule.when(ctx, { ticketId: 1, commentByAgent: "bob" }), false);
});

test("assigned-to-other rule fires when assignee != consumer AND != null", () => {
    const rule = findRule("assigned-to-other");
    const ctx = mkCtx({ consumerId: "me" });
    assert.equal(rule.when(ctx, { ticketId: 1, assignee: "other" }), true);
    assert.equal(rule.when(ctx, { ticketId: 1, assignee: "me" }), false);
    assert.equal(rule.when(ctx, { ticketId: 1, assignee: null }), false);
});

test("assigned-to-other rule excludes ONLY backlog-tier", () => {
    const rule = findRule("assigned-to-other");
    assert.equal(rule.excludesFrom.has("backlog-tier"), true);
    assert.equal(rule.excludesFrom.has("unread-list"), false);
    assert.equal(rule.excludesFrom.has("unread-count"), false);
});

// =====================================================================
//  Dispatch
// =====================================================================

test("#900 claimed-by-other excludes from backlog-tier + fifo-wake", () => {
    const ctx = mkCtx({ claimedByOtherIds: new Set([42]) });
    const item = { ticketId: 42 };
    // backlog-tier + fifo-wake : exclues
    assert.equal(defaultBacklogRules.excludes(ctx, item, "backlog-tier"), true);
    assert.equal(defaultBacklogRules.excludes(ctx, item, "fifo-wake"), true);
    // unread-list/count + actionable-pool + hot-tier : pas exclues (le ticket
    // peut quand même se surfacer via unread directs, on coupe juste le wake CTA)
    assert.equal(defaultBacklogRules.excludes(ctx, item, "unread-list"), false);
    assert.equal(defaultBacklogRules.excludes(ctx, item, "actionable-pool"), false);
    assert.equal(defaultBacklogRules.excludes(ctx, item, "hot-tier"), false);
});

test("#900 claimed-by-other ignores items not in claimedByOtherIds", () => {
    const ctx = mkCtx({ claimedByOtherIds: new Set([42]) });
    const item = { ticketId: 99 };
    assert.equal(defaultBacklogRules.excludes(ctx, item, "backlog-tier"), false);
    assert.equal(defaultBacklogRules.excludes(ctx, item, "fifo-wake"), false);
});

test("engine.excludes returns true iff any active rule on target fires", () => {
    const ctx = mkCtx({ closedIds: new Set([1]) });
    // closed fires AND target = backlog-tier → excluded
    assert.equal(defaultBacklogRules.excludes(ctx, { ticketId: 1 }, "backlog-tier"), true);
    // closed fires BUT target = unread-list (closed doesn't exclude this) → NOT excluded
    assert.equal(defaultBacklogRules.excludes(ctx, { ticketId: 1 }, "unread-list"), false);
});

test("engine.filter drops excluded items only", () => {
    const ctx = mkCtx({ closedIds: new Set([1, 3]), snoozedIds: new Set([2]) });
    const items = [
        { ticketId: 1 }, { ticketId: 2 }, { ticketId: 3 }, { ticketId: 4 },
    ];
    // backlog-tier : closed + snoozed both exclude
    const backlog = defaultBacklogRules.filter(items, (i) => i, ctx, "backlog-tier");
    assert.deepEqual(backlog.map((i) => i.ticketId), [4]);
    // unread-list : snoozed exclues, closed n'exclut PAS (#805)
    const unread = defaultBacklogRules.filter(items, (i) => i, ctx, "unread-list");
    assert.deepEqual(unread.map((i) => i.ticketId).sort(), [1, 3, 4]);
});

test("engine.rulesFor lists every rule affecting a target", () => {
    const backlog = defaultBacklogRules.rulesFor("backlog-tier").map((r) => r.name);
    assert.ok(backlog.includes("closed"));
    assert.ok(backlog.includes("snoozed"));
    assert.ok(backlog.includes("assigned-to-other"));
    const unreadCount = defaultBacklogRules.rulesFor("unread-count").map((r) => r.name);
    assert.ok(unreadCount.includes("snoozed"));
    assert.ok(unreadCount.includes("self-authored-ticket"));
    assert.ok(unreadCount.includes("self-authored-comment"));
    assert.ok(!unreadCount.includes("closed")); // #805
});

test("engine accepts custom rule set", () => {
    const custom = new BacklogRules([
        {
            name: "always",
            when: () => true,
            excludesFrom: new Set<Target>(["unread-list"]),
        },
    ]);
    const ctx = mkCtx();
    assert.equal(custom.excludes(ctx, { ticketId: 1 }, "unread-list"), true);
    assert.equal(custom.excludes(ctx, { ticketId: 1 }, "backlog-tier"), false);
});

test("self-authored-ticket + assigned-to-other compose : different targets, both fire", () => {
    const ctx = mkCtx({ consumerId: "me" });
    const item: RuleItem = { ticketId: 1, ticketByAgent: "me", assignee: "someone-else" };
    // self-authored excludes from unread-*
    assert.equal(defaultBacklogRules.excludes(ctx, item, "unread-list"), true);
    // assigned-to-other excludes from backlog-tier
    assert.equal(defaultBacklogRules.excludes(ctx, item, "backlog-tier"), true);
});

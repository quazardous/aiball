// #483 — pure tests for the moderation verdict reroute. node:test, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideFromRules, strategyDefault } from "./rules.js";
import {
    synthesizeLegacyExpression,
    type AutomationAction,
    type AutomationRule,
    type ConditionTree,
} from "./db/automation.js";
import type { MessagePostedEvent } from "./automation/engine.js";

interface RulePartial {
    id?: number;
    match_project?: string | null;
    match_kind?: string | null;
    match_by_agent?: string | null;
    action?: AutomationAction;
    expression?: ConditionTree;
    position?: number;
}

function rule(p: RulePartial): AutomationRule {
    const match_project = p.match_project ?? null;
    const match_kind = p.match_kind ?? null;
    const match_by_agent = p.match_by_agent ?? null;
    const expression: ConditionTree =
        p.expression ??
        synthesizeLegacyExpression({
            match_project,
            match_kind,
            match_by_agent,
            match_intent: null,
            match_priority: null,
            match_tag_added: null,
            match_tags: [],
            scope_consumer: null,
        });
    const action: AutomationAction = p.action ?? { kind: "decision", decision: "review" };
    return {
        id: p.id ?? 1,
        triggers: ["message_posted"],
        scope_consumer: null,
        match_project,
        match_kind,
        match_by_agent,
        match_tags: [],
        match_tag_added: null,
        match_intent: null,
        match_priority: null,
        action,
        enabled: 1,
        position: p.position ?? 0,
        note: null,
        created_at: "2026-05-27T00:00:00.000Z",
        expression,
        actions: [action],
    };
}

function ev(p: Partial<MessagePostedEvent> = {}): MessagePostedEvent {
    return {
        trigger: "message_posted",
        project: p.project ?? "aiball",
        kind: p.kind ?? "ticket_created",
        by_agent: p.by_agent ?? "claude-aiball-dev",
    };
}

test("no rules → null (caller falls back to strategy)", () => {
    assert.equal(decideFromRules([], ev()), null);
});

test("first matching rule wins (order = position then id)", () => {
    const r1 = rule({ id: 10, position: 0, action: { kind: "decision", decision: "auto" } });
    const r2 = rule({ id: 11, position: 1, action: { kind: "decision", decision: "review" } });
    assert.deepEqual(decideFromRules([r1, r2], ev()), { decision: "auto", matched_rule_id: 10 });
});

test("match by project narrowing", () => {
    const r = rule({ match_project: "aiball", action: { kind: "decision", decision: "auto" } });
    assert.deepEqual(decideFromRules([r], ev({ project: "aiball" })), {
        decision: "auto",
        matched_rule_id: 1,
    });
    assert.equal(decideFromRules([r], ev({ project: "other" })), null);
});

test("rule whose action is NOT decision → ignored (defensive, fallback to strategy)", () => {
    const r = rule({ match_project: "aiball", action: { kind: "assign", consumer_id: "x" } });
    assert.equal(decideFromRules([r], ev({ project: "aiball" })), null);
});

test("strategyDefault behaves per spec", () => {
    assert.equal(strategyDefault("auto", "ticket_created"), "auto");
    assert.equal(strategyDefault("manual", "ticket_created"), "review");
    assert.equal(strategyDefault("auto-reply", "comment_added"), "auto");
    assert.equal(strategyDefault("auto-reply", "ticket_created"), "review");
});

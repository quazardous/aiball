// #483 — pure tests for the pickup work-filter gate. node:test, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePickup } from "./work-filter-gate.js";
import {
    synthesizeLegacyExpression,
    type AutomationAction,
    type AutomationRule,
    type ConditionTree,
} from "../db/automation.js";
import type { ActionableEvalEvent } from "./engine.js";

interface RulePartial {
    id?: number;
    scope_consumer?: string | null;
    match_project?: string | null;
    match_tags?: string[];
    action?: AutomationAction;
    expression?: ConditionTree;
}

function rule(p: RulePartial): AutomationRule {
    const scope_consumer = p.scope_consumer ?? null;
    const match_project = p.match_project ?? null;
    const match_tags = p.match_tags ?? [];
    const expression: ConditionTree =
        p.expression ??
        synthesizeLegacyExpression({
            match_project,
            match_kind: null,
            match_by_agent: null,
            match_intent: null,
            match_priority: null,
            match_tag_added: null,
            match_tags,
            scope_consumer,
        });
    const action: AutomationAction = p.action ?? { kind: "pickup", mode: "only" };
    return {
        id: p.id ?? 1,
        triggers: ["actionable_eval"],
        scope_consumer,
        match_project,
        match_kind: null,
        match_by_agent: null,
        match_tags,
        match_tag_added: null,
        match_intent: null,
        match_priority: null,
        action,
        enabled: 1,
        position: 0,
        note: null,
        created_at: "2026-05-27T00:00:00.000Z",
        expression,
        actions: [action],
    };
}

function ev(consumer: string, project: string, tags: string[]): ActionableEvalEvent {
    return { trigger: "actionable_eval", consumer_id: consumer, project, ticket_tags: tags };
}

test("no rules → everything passes", () => {
    assert.equal(evaluatePickup([], ev("agent", "aiball", ["win"])), true);
    assert.equal(evaluatePickup([], ev("agent", "aiball", [])), true);
});

test("only-rule that matches → ticket passes", () => {
    const r = rule({ match_project: "aiball", match_tags: ["win"], action: { kind: "pickup", mode: "only" } });
    assert.equal(evaluatePickup([r], ev("agent", "aiball", ["win"])), true);
});

test("only-rule that DOESN'T match → ticket passes (new semantic vs legacy)", () => {
    // Legacy ticketPassesWorkFilters aurait exclu le ticket (only existe mais tag absent).
    // Moteur unifié : rule ne matche pas → matched=[] → pass-through.
    const r = rule({ match_project: "aiball", match_tags: ["win"], action: { kind: "pickup", mode: "only" } });
    assert.equal(evaluatePickup([r], ev("agent", "aiball", ["linux"])), true);
    assert.equal(evaluatePickup([r], ev("agent", "aiball", [])), true);
});

test("except-rule that matches → ticket filtered out", () => {
    const r = rule({ match_project: "aiball", match_tags: ["wip"], action: { kind: "pickup", mode: "except" } });
    assert.equal(evaluatePickup([r], ev("agent", "aiball", ["wip"])), false);
    assert.equal(evaluatePickup([r], ev("agent", "aiball", ["win"])), true);
});

test("scope_consumer narrows : rule with another consumer → ignored", () => {
    const r = rule({
        scope_consumer: "aiball-windows",
        match_project: "aiball",
        match_tags: ["win"],
        action: { kind: "pickup", mode: "except" },
    });
    // Different consumer → rule's scope_consumer narrows it out at the matcher.
    assert.equal(evaluatePickup([r], ev("agent", "aiball", ["win"])), true);
    // Same consumer → except fires, ticket filtered.
    assert.equal(evaluatePickup([r], ev("aiball-windows", "aiball", ["win"])), false);
});

test("scope_consumer NULL → fires for any consumer", () => {
    const r = rule({
        scope_consumer: null,
        match_project: "aiball",
        match_tags: ["wip"],
        action: { kind: "pickup", mode: "except" },
    });
    assert.equal(evaluatePickup([r], ev("anyone", "aiball", ["wip"])), false);
    assert.equal(evaluatePickup([r], ev("other-agent", "aiball", ["wip"])), false);
});

test("except wins over only when both match", () => {
    const only = rule({
        id: 1,
        match_project: "aiball",
        match_tags: ["win"],
        action: { kind: "pickup", mode: "only" },
    });
    const except = rule({
        id: 2,
        match_project: "aiball",
        match_tags: ["wip"],
        action: { kind: "pickup", mode: "except" },
    });
    assert.equal(evaluatePickup([only, except], ev("agent", "aiball", ["win", "wip"])), false);
});

test("non-pickup actions on actionable_eval rules are ignored (defensive)", () => {
    const weird = rule({
        match_project: "aiball",
        // misconfig : action.kind != "pickup" on an actionable_eval rule.
        action: { kind: "assign", consumer_id: "other-agent" },
    });
    assert.equal(evaluatePickup([weird], ev("agent", "aiball", [])), true);
});

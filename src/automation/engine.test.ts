// #457 — pure tests for the automation engine matcher (no DB, node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    allMatchingRules,
    firstMatchingRule,
    ruleMatchesEvent,
    type AutomationEvent,
} from "./engine.js";
import type { AutomationRule, Trigger } from "../db/automation.js";

function rule(p: Partial<AutomationRule>): AutomationRule {
    return {
        id: p.id ?? 1,
        triggers: p.triggers ?? (["ticket_created"] as Trigger[]),
        scope_consumer: p.scope_consumer ?? null,
        match_project: p.match_project ?? null,
        match_kind: p.match_kind ?? null,
        match_by_agent: p.match_by_agent ?? null,
        match_tags: p.match_tags ?? [],
        match_tag_added: p.match_tag_added ?? null,
        match_intent: p.match_intent ?? null,
        match_priority: p.match_priority ?? null,
        action: p.action ?? { kind: "decision", decision: "review" },
        enabled: p.enabled ?? 1,
        position: p.position ?? 0,
        note: p.note ?? null,
        created_at: p.created_at ?? "2026-05-26T00:00:00.000Z",
    };
}

// ---------------------------------------------------------------------------
// Common — trigger mismatch + project condition.
// ---------------------------------------------------------------------------

test("rule with mismatched trigger never fires", () => {
    const r = rule({ triggers: ["message_posted"] });
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    assert.equal(ruleMatchesEvent(r, e), false);
});

test("rule with EMPTY triggers list never fires (fail-closed)", () => {
    const r = rule({ triggers: [] });
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    assert.equal(ruleMatchesEvent(r, e), false);
});

test("triggers UNION (david `8r7crj`) : rule fires for ANY listed trigger", () => {
    // david's scenario : same rule for "ticket created with tag win" AND
    // "tag win added later" — one rule, two triggers, no duplication.
    const r = rule({
        triggers: ["ticket_created", "ticket_tagged"],
        match_tags: ["win"],
        action: { kind: "assign", consumer_id: "aiball-windows" },
    });
    const createdEvent: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: "david", intent: "request", priority: "normal",
        ticket_tags: ["win"],
    };
    const taggedEvent: AutomationEvent = {
        trigger: "ticket_tagged", project: "aiball",
        tag_added: "win", ticket_tags: ["win"], intent: null, priority: null,
    };
    const otherTriggerEvent: AutomationEvent = {
        trigger: "message_posted", project: "aiball",
        kind: "comment_added", by_agent: "alice",
    };
    assert.equal(ruleMatchesEvent(r, createdEvent), true);
    assert.equal(ruleMatchesEvent(r, taggedEvent), true);
    assert.equal(ruleMatchesEvent(r, otherTriggerEvent), false);
});

test("match_project NULL → matches any project", () => {
    const r = rule({ triggers: ["ticket_created"] });
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    assert.equal(ruleMatchesEvent(r, e), true);
});

test("match_project set → only matches the named project", () => {
    const r = rule({ triggers: ["ticket_created"], match_project: "aiball" });
    const aiball: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    const other: AutomationEvent = { ...aiball, project: "qcmp" };
    assert.equal(ruleMatchesEvent(r, aiball), true);
    assert.equal(ruleMatchesEvent(r, other), false);
});

// ---------------------------------------------------------------------------
// message_posted (legacy moderation shape) — kind + by_agent.
// ---------------------------------------------------------------------------

test("message_posted : match_kind narrows by message kind", () => {
    const r = rule({ triggers: ["message_posted"], match_kind: "comment_added" });
    const e = (kind: string): AutomationEvent => ({
        trigger: "message_posted", project: "aiball", kind, by_agent: "alice",
    });
    assert.equal(ruleMatchesEvent(r, e("comment_added")), true);
    assert.equal(ruleMatchesEvent(r, e("ticket_created")), false);
});

test("message_posted : match_by_agent narrows by author", () => {
    const r = rule({ triggers: ["message_posted"], match_by_agent: "alice" });
    const e = (by_agent: string | null): AutomationEvent => ({
        trigger: "message_posted", project: "aiball", kind: "comment_added", by_agent,
    });
    assert.equal(ruleMatchesEvent(r, e("alice")), true);
    assert.equal(ruleMatchesEvent(r, e("bob")), false);
    assert.equal(ruleMatchesEvent(r, e(null)), false);
});

// ---------------------------------------------------------------------------
// actionable_eval — tags any-of + scope_consumer.
// ---------------------------------------------------------------------------

test("actionable_eval : match_tags any-of", () => {
    const r = rule({ triggers: ["actionable_eval"], match_tags: ["win", "urgent"] });
    const e = (ticket_tags: string[]): AutomationEvent => ({
        trigger: "actionable_eval", consumer_id: "agent", project: "aiball", ticket_tags,
    });
    assert.equal(ruleMatchesEvent(r, e(["win"])), true);
    assert.equal(ruleMatchesEvent(r, e(["urgent", "x"])), true);
    assert.equal(ruleMatchesEvent(r, e([])), false);
    assert.equal(ruleMatchesEvent(r, e(["linux"])), false);
});

test("actionable_eval : empty match_tags matches everything", () => {
    const r = rule({ triggers: ["actionable_eval"], match_tags: [] });
    const e: AutomationEvent = {
        trigger: "actionable_eval", consumer_id: "agent", project: "aiball", ticket_tags: [],
    };
    assert.equal(ruleMatchesEvent(r, e), true);
});

test("actionable_eval : scope_consumer mismatch fails closed", () => {
    const r = rule({ triggers: ["actionable_eval"], scope_consumer: "alice" });
    const e: AutomationEvent = {
        trigger: "actionable_eval", consumer_id: "bob", project: "aiball", ticket_tags: [],
    };
    assert.equal(ruleMatchesEvent(r, e), false);
});

// ---------------------------------------------------------------------------
// ticket_created — david's scenario 1 : tag `win` → assign.
// ---------------------------------------------------------------------------

test("ticket_created : has_tags any-of matches david's scenario", () => {
    const r = rule({
        triggers: ["ticket_created"],
        match_tags: ["win"],
        action: { kind: "assign", consumer_id: "aiball-windows" },
    });
    const e = (ticket_tags: string[]): AutomationEvent => ({
        trigger: "ticket_created", project: "aiball",
        by_agent: "david", intent: "request", priority: "normal",
        ticket_tags,
    });
    assert.equal(ruleMatchesEvent(r, e(["win"])), true);
    assert.equal(ruleMatchesEvent(r, e(["win", "urgent"])), true);
    assert.equal(ruleMatchesEvent(r, e(["linux"])), false);
    assert.equal(ruleMatchesEvent(r, e([])), false);
});

test("ticket_created : combines intent + priority + tags AND-wise", () => {
    const r = rule({
        triggers: ["ticket_created"],
        match_intent: "panic",
        match_priority: "urgent",
        match_tags: ["security"],
    });
    const e = (intent: string, priority: string, ticket_tags: string[]): AutomationEvent => ({
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent, priority, ticket_tags,
    });
    assert.equal(ruleMatchesEvent(r, e("panic", "urgent", ["security"])), true);
    assert.equal(ruleMatchesEvent(r, e("request", "urgent", ["security"])), false);
    assert.equal(ruleMatchesEvent(r, e("panic", "normal", ["security"])), false);
    assert.equal(ruleMatchesEvent(r, e("panic", "urgent", ["bug"])), false);
});

// ---------------------------------------------------------------------------
// ticket_tagged — david's scenario 2 : tag `win` added later → assign.
// ---------------------------------------------------------------------------

test("ticket_tagged : match_tag_added narrows to the specific tag just added", () => {
    const r = rule({
        triggers: ["ticket_tagged"],
        match_tag_added: "win",
        action: { kind: "assign", consumer_id: "aiball-windows" },
    });
    const e = (tag_added: string, ticket_tags: string[]): AutomationEvent => ({
        trigger: "ticket_tagged", project: "aiball",
        tag_added, ticket_tags, intent: null, priority: null,
    });
    assert.equal(ruleMatchesEvent(r, e("win", ["win"])), true);
    assert.equal(ruleMatchesEvent(r, e("linux", ["win", "linux"])), false);
});

test("ticket_tagged : NULL match_tag_added = any tag addition", () => {
    const r = rule({ triggers: ["ticket_tagged"], match_tag_added: null });
    const e: AutomationEvent = {
        trigger: "ticket_tagged", project: "aiball",
        tag_added: "anything", ticket_tags: ["anything"], intent: null, priority: null,
    };
    assert.equal(ruleMatchesEvent(r, e), true);
});

// ---------------------------------------------------------------------------
// firstMatchingRule (first-match-wins default, david `x4pejb`) +
// allMatchingRules (all-apply, for work-filter etc.). Caller pre-orders by
// (position, id) ; the engine doesn't re-sort.
// ---------------------------------------------------------------------------

test("firstMatchingRule returns the first match in caller order", () => {
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: ["win"],
    };
    const rules = [
        rule({ id: 10, position: 0, triggers: ["ticket_created"], match_tags: ["urgent"] }),
        rule({ id: 20, position: 5, triggers: ["ticket_created"], match_tags: ["win"] }),
        rule({ id: 30, position: 10, triggers: ["ticket_created"], match_tags: ["win"] }),
    ];
    const got = firstMatchingRule(rules, e);
    assert.equal(got?.id, 20);
});

test("firstMatchingRule with no matches → null", () => {
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    const rules = [
        rule({ triggers: ["ticket_created"], match_tags: ["win"] }),
        rule({ triggers: ["ticket_tagged"] }),
    ];
    assert.equal(firstMatchingRule(rules, e), null);
});

test("allMatchingRules returns rules in caller-provided order", () => {
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: ["win"],
    };
    const rules = [
        rule({ id: 10, position: 0, triggers: ["ticket_created"], match_tags: ["win"] }),
        rule({ id: 20, position: 5, triggers: ["ticket_created"], match_tags: ["urgent"] }),
        rule({ id: 30, position: 10, triggers: ["ticket_created"], match_tags: ["win"] }),
    ];
    const got = allMatchingRules(rules, e);
    assert.deepEqual(got.map((r) => r.id), [10, 30]);
});

test("allMatchingRules with no matches → empty array", () => {
    const e: AutomationEvent = {
        trigger: "ticket_created", project: "aiball",
        by_agent: null, intent: null, priority: null, ticket_tags: [],
    };
    const rules = [
        rule({ triggers: ["ticket_created"], match_tags: ["win"] }),
        rule({ triggers: ["ticket_tagged"] }),
    ];
    assert.deepEqual(allMatchingRules(rules, e), []);
});

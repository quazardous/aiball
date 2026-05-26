// #457 — pure tests for the automation engine matcher (no DB, node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    allMatchingRules,
    evaluateExpression,
    firstMatchingRule,
    ruleMatchesEvent,
    type AutomationEvent,
} from "./engine.js";
import {
    synthesizeLegacyExpression,
    type AutomationRule,
    type ConditionTree,
    type Trigger,
} from "../db/automation.js";

function rule(p: Partial<AutomationRule>): AutomationRule {
    const scope_consumer = p.scope_consumer ?? null;
    const match_project = p.match_project ?? null;
    const match_kind = p.match_kind ?? null;
    const match_by_agent = p.match_by_agent ?? null;
    const match_tags = p.match_tags ?? [];
    const match_tag_added = p.match_tag_added ?? null;
    const match_intent = p.match_intent ?? null;
    const match_priority = p.match_priority ?? null;
    // Tests built before slice 5.1 set the legacy flat fields. Synthesize an
    // equivalent AND-tree (mirrors rowToRule's back-compat synthesis) when
    // the caller didn't pass an explicit `expression`.
    const expression: ConditionTree =
        p.expression ??
        synthesizeLegacyExpression({
            match_project,
            match_kind,
            match_by_agent,
            match_intent,
            match_priority,
            match_tag_added,
            match_tags,
            scope_consumer,
        });
    return {
        id: p.id ?? 1,
        triggers: p.triggers ?? (["ticket_created"] as Trigger[]),
        scope_consumer,
        match_project,
        match_kind,
        match_by_agent,
        match_tags,
        match_tag_added,
        match_intent,
        match_priority,
        action: p.action ?? { kind: "decision", decision: "review" },
        enabled: p.enabled ?? 1,
        position: p.position ?? 0,
        note: p.note ?? null,
        created_at: p.created_at ?? "2026-05-26T00:00:00.000Z",
        expression,
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

// ---------------------------------------------------------------------------
// Slice 5.1 — compositional condition tree (david `dxrn2u`).
// `evaluateExpression` walks the tree ; the legacy flat-fields path
// synthesizes an equivalent AND-tree at read time. These tests pin the
// recursive semantics + every leaf op.
// ---------------------------------------------------------------------------

const ticketCreatedEv = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
    trigger: "ticket_created",
    project: "aiball",
    by_agent: null,
    intent: null,
    priority: null,
    ticket_tags: [],
    ...overrides,
} as AutomationEvent);

test("evaluateExpression : empty AND matches everything (vacuous true)", () => {
    assert.equal(evaluateExpression({ kind: "and", children: [] }, ticketCreatedEv()), true);
});

test("evaluateExpression : empty OR matches nothing (vacuous false)", () => {
    assert.equal(evaluateExpression({ kind: "or", children: [] }, ticketCreatedEv()), false);
});

test("evaluateExpression : NOT flips its child", () => {
    const ev = ticketCreatedEv({ project: "aiball" });
    const isAiball: ConditionTree = { kind: "leaf", field: "project", op: "eq", value: "aiball" };
    assert.equal(evaluateExpression({ kind: "not", child: isAiball }, ev), false);
    const isOther: ConditionTree = { kind: "leaf", field: "project", op: "eq", value: "other" };
    assert.equal(evaluateExpression({ kind: "not", child: isOther }, ev), true);
});

test("evaluateExpression : leaf eq / neq on event fields", () => {
    const ev = ticketCreatedEv({ project: "aiball", intent: "urgent" });
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "project", op: "eq", value: "aiball" }, ev), true);
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "project", op: "neq", value: "aiball" }, ev), false);
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "intent", op: "eq", value: "urgent" }, ev), true);
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "intent", op: "eq", value: "fyi" }, ev), false);
});

test("evaluateExpression : leaf `in` matches when event value ∈ list", () => {
    const ev = ticketCreatedEv({ intent: "question" });
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "intent", op: "in", value: ["request", "question"] }, ev), true);
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "intent", op: "in", value: ["fyi", "panic"] }, ev), false);
});

test("evaluateExpression : leaf `includes` matches when value ∈ event array", () => {
    const ev = ticketCreatedEv({ ticket_tags: ["win", "urgent"] });
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "tags", op: "includes", value: "win" }, ev), true);
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "tags", op: "includes", value: "linux" }, ev), false);
});

test("evaluateExpression : leaf on a field the event doesn't carry → fail-closed", () => {
    // `tag_added` only exists on a `ticket_tagged` event ; querying it from
    // a `ticket_created` payload should fail closed.
    const ev = ticketCreatedEv();
    assert.equal(evaluateExpression(
        { kind: "leaf", field: "tag_added", op: "eq", value: "win" }, ev), false);
});

test("evaluateExpression : david's compositional scenario (project=aiball AND tags includes win) OR (intent=urgent)", () => {
    // The whole point of slice 5.1 : the previous flat schema couldn't
    // express this without duplicating rules. Now it's one tree.
    const tree: ConditionTree = {
        kind: "or",
        children: [
            {
                kind: "and",
                children: [
                    { kind: "leaf", field: "project", op: "eq", value: "aiball" },
                    { kind: "leaf", field: "tags", op: "includes", value: "win" },
                ],
            },
            { kind: "leaf", field: "intent", op: "eq", value: "urgent" },
        ],
    };
    // Case 1 : aiball + win tag → first branch hits.
    assert.equal(evaluateExpression(tree,
        ticketCreatedEv({ project: "aiball", ticket_tags: ["win"] })), true);
    // Case 2 : intent=urgent (other project) → second branch hits.
    assert.equal(evaluateExpression(tree,
        ticketCreatedEv({ project: "other", intent: "urgent" })), true);
    // Case 3 : aiball but no win tag, not urgent → no branch matches.
    assert.equal(evaluateExpression(tree,
        ticketCreatedEv({ project: "aiball", ticket_tags: ["linux"], intent: "request" })),
        false);
    // Case 4 : urgent but on a TICKET_TAGGED event (no `intent` in payload? actually
    // ticket_tagged DOES carry intent, so this should match) :
    const ttEvUrgent: AutomationEvent = {
        trigger: "ticket_tagged", project: "other", tag_added: "x",
        ticket_tags: ["x"], intent: "urgent", priority: null,
    };
    assert.equal(evaluateExpression(tree, ttEvUrgent), true);
});

test("evaluateExpression : deep nesting (3 levels) still resolves correctly", () => {
    const tree: ConditionTree = {
        kind: "and",
        children: [
            { kind: "leaf", field: "project", op: "eq", value: "aiball" },
            {
                kind: "or",
                children: [
                    { kind: "leaf", field: "intent", op: "eq", value: "urgent" },
                    {
                        kind: "and",
                        children: [
                            { kind: "leaf", field: "tags", op: "includes", value: "win" },
                            { kind: "not", child: { kind: "leaf", field: "intent", op: "eq", value: "fyi" } },
                        ],
                    },
                ],
            },
        ],
    };
    // win-tagged ticket, intent=request (NOT fyi), in aiball → AND → OR's
    // second child → inner AND with both → true.
    assert.equal(evaluateExpression(tree,
        ticketCreatedEv({ project: "aiball", ticket_tags: ["win"], intent: "request" })),
        true);
    // win-tagged but intent=fyi → inner NOT flips, inner AND fails ; OR's
    // first child also fails (not urgent) → false.
    assert.equal(evaluateExpression(tree,
        ticketCreatedEv({ project: "aiball", ticket_tags: ["win"], intent: "fyi" })),
        false);
});

test("ruleMatchesEvent : legacy flat-fields rule still matches identically via synthesized tree", () => {
    // The whole back-compat invariant : a rule with NULL `expression` on
    // disk (= the `rule()` helper synthesizes one from the flat fields)
    // evaluates exactly like before slice 5.1.
    const r = rule({
        triggers: ["ticket_created"],
        match_project: "aiball",
        match_tags: ["win"],
    });
    const yes = ticketCreatedEv({ project: "aiball", ticket_tags: ["win"] });
    const no = ticketCreatedEv({ project: "aiball", ticket_tags: ["linux"] });
    assert.equal(ruleMatchesEvent(r, yes), true);
    assert.equal(ruleMatchesEvent(r, no), false);
});

test("ruleMatchesEvent : explicit expression overrides flat fields", () => {
    // A new-style rule with an explicit OR tree — the flat fields are
    // null'd out (no AND filter on top of the OR).
    const r = rule({
        triggers: ["ticket_created"],
        expression: {
            kind: "or",
            children: [
                { kind: "leaf", field: "tags", op: "includes", value: "win" },
                { kind: "leaf", field: "intent", op: "eq", value: "urgent" },
            ],
        },
    });
    assert.equal(ruleMatchesEvent(r, ticketCreatedEv({ ticket_tags: ["win"] })), true);
    assert.equal(ruleMatchesEvent(r, ticketCreatedEv({ intent: "urgent" })), true);
    assert.equal(ruleMatchesEvent(r, ticketCreatedEv({ ticket_tags: ["linux"] })), false);
});

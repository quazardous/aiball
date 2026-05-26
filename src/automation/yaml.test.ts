// #457 slice 3 — pure parser tests for the YAML automation loader. No DB,
// no filesystem ; we feed `parseAutomationBlock` the raw parsed-YAML value
// directly and assert on the shape it returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAutomationBlock } from "./yaml.js";

const SRC = "test.yaml";

test("parseAutomationBlock : decodes david's canonical win-tag rule", () => {
    const { rules, nextId } = parseAutomationBlock(
        [
            {
                name: "Win tickets to Windows agent",
                triggers: ["ticket_created", "ticket_tagged"],
                when: { has_tags: ["win"] },
                do: { assign_to: "aiball-windows" },
            },
        ],
        -1,
        SRC,
    );
    assert.equal(rules.length, 1);
    const r = rules[0]!;
    assert.equal(r.id, -1, "synthetic negative id from startId");
    assert.deepEqual(r.triggers, ["ticket_created", "ticket_tagged"]);
    assert.deepEqual(r.match_tags, ["win"]);
    assert.equal(r.action.kind, "assign");
    assert.equal((r.action as { consumer_id: string }).consumer_id, "aiball-windows");
    assert.equal(r.enabled, 1);
    assert.equal(r.note, "Win tickets to Windows agent", "name falls back into note when no explicit note");
    assert.equal(nextId, -2, "id counter advances after each accepted rule");
});

test("parseAutomationBlock : accepts a single trigger string (sugar)", () => {
    const { rules } = parseAutomationBlock(
        [{ triggers: "ticket_tagged", do: { assign_to: "x" } }],
        -1,
        SRC,
    );
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0]!.triggers, ["ticket_tagged"]);
});

test("parseAutomationBlock : tolerates the singular `trigger:` alias", () => {
    const { rules } = parseAutomationBlock(
        [{ trigger: "ticket_created", do: { decision: "auto" } }],
        -1,
        SRC,
    );
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0]!.triggers, ["ticket_created"]);
});

test("parseAutomationBlock : `enabled: false` flips the flag", () => {
    const { rules } = parseAutomationBlock(
        [
            {
                triggers: ["ticket_tagged"],
                do: { add_tag: "needs-triage" },
                enabled: false,
            },
        ],
        -1,
        SRC,
    );
    assert.equal(rules[0]!.enabled, 0);
});

test("parseAutomationBlock : every action kind round-trips", () => {
    const { rules } = parseAutomationBlock(
        [
            { triggers: ["ticket_created"], do: { assign_to: "agent-a" } },
            { triggers: ["message_posted"], do: { decision: "review" } },
            { triggers: ["actionable_eval"], do: { pickup: "except" } },
            { triggers: ["ticket_tagged"], do: { add_tag: "auto-tag" } },
            { triggers: ["ticket_created"], do: { set_priority: "urgent" } },
            { triggers: ["ticket_created"], do: { notify: "agent-b" } },
        ],
        -1,
        SRC,
    );
    assert.deepEqual(rules.map((r) => r.action.kind), [
        "assign", "decision", "pickup", "add_tag", "set_priority", "notify",
    ]);
});

test("parseAutomationBlock : skips malformed entries (no trigger, no action)", () => {
    const { rules } = parseAutomationBlock(
        [
            { do: { decision: "auto" } }, // no trigger
            { triggers: ["ticket_created"] }, // no action
            { triggers: ["bogus_trigger"], do: { decision: "auto" } }, // bad trigger
            { triggers: ["ticket_created"], do: { weird_action: true } }, // bad action
            { triggers: ["ticket_created"], do: { assign_to: "ok" } }, // valid → kept
        ],
        -1,
        SRC,
    );
    assert.equal(rules.length, 1, "only the well-formed entry survived");
    assert.equal(rules[0]!.action.kind, "assign");
});

test("parseAutomationBlock : decodes every `when:` field", () => {
    const { rules } = parseAutomationBlock(
        [
            {
                triggers: ["message_posted"],
                when: {
                    project: "aiball",
                    has_tags: ["a", "b"],
                    tag_added: "win",
                    by_agent: "claude",
                    kind: "comment_added",
                    intent: "request",
                    priority: "urgent",
                    scope_consumer: "agent-X",
                },
                do: { decision: "auto" },
            },
        ],
        -1,
        SRC,
    );
    const r = rules[0]!;
    assert.equal(r.match_project, "aiball");
    assert.deepEqual(r.match_tags, ["a", "b"]);
    assert.equal(r.match_tag_added, "win");
    assert.equal(r.match_by_agent, "claude");
    assert.equal(r.match_kind, "comment_added");
    assert.equal(r.match_intent, "request");
    assert.equal(r.match_priority, "urgent");
    assert.equal(r.scope_consumer, "agent-X");
});

test("parseAutomationBlock : returns empty list on non-array input", () => {
    assert.deepEqual(parseAutomationBlock(null, -1, SRC), { rules: [], nextId: -1 });
    assert.deepEqual(parseAutomationBlock({}, -1, SRC), { rules: [], nextId: -1 });
    assert.deepEqual(parseAutomationBlock("not a list", -1, SRC), { rules: [], nextId: -1 });
});

test("parseAutomationBlock : rejects out-of-vocabulary priority", () => {
    const { rules } = parseAutomationBlock(
        [
            {
                triggers: ["ticket_created"],
                when: { priority: "extreme" }, // not in urgent|high|normal|low
                do: { assign_to: "x" },
            },
        ],
        -1,
        SRC,
    );
    assert.equal(rules[0]!.match_priority, null, "bad priority dropped, rule still loads");
});

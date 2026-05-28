// #457 slice 2 — automation runtime integration test.
//
// Drives a REAL throwaway SQLite (migrations 0039 + 0040 run on the first
// getDb), exercises submitMessage → emitLifecycle → runtime → setTicketAssignment
// end-to-end. The tag-trigger arm emits the lifecycle event directly
// (mirroring what `api/tags.ts` does in-process), since this test stays out
// of Express. node:test + tsx — run via `npm test`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the DB at a throwaway home BEFORE importing anything that reads paths.
process.env.AIBALL_HOME = mkdtempSync(join(tmpdir(), "aiball-457-slice2-"));

const { getDb } = await import("../db/connection.js");
const { submitMessage } = await import("../messages.js");
const { upsertConsumer } = await import("../db/consumers.js");
const { insertAutomationRule, listAutomationRules, setAutomationRuleEnabled } = await import("../db/automation.js");
const { registerAutomationRuntime } = await import("./runtime.js");
const { emitLifecycle } = await import("../event-bus.js");
const { getMessage } = await import("../db/messages.js");
const { insertTag, addMessageTag, listMessageTags } = await import("../db/tags.js");
const { createProject } = await import("../db/projects.js");

// Open the DB up front (runs migrations) so subsequent test ordering doesn't
// race the first-call boot path.
getDb();

// #561 : submitMessage(ticket_created) requires the project to exist. Pre-create
// both fixtures projects so the auto-assign scenarios can post tickets without
// tripping the new guard.
createProject({ name: "sim-457-slice2" });
createProject({ name: "sim-other" });

// Register the runtime once. Subsequent calls inside the same process are
// idempotent — guarded in registerAutomationRuntime().
registerAutomationRuntime();

const PROJECT = "sim-457-slice2";
const REPORTER = "david-human";
const TARGET_AGENT = "aiball-windows";

// Mark the reporter as human so submitMessage auto-approves (`isHuman` bypass
// in rules.ts), making the test deterministic regardless of the project's
// moderation strategy.
upsertConsumer({ consumer_id: REPORTER, kind: "human" });
// And register the target so subscription writes have a row to FK against
// (`upsertTicketSubscription` doesn't itself create the consumer).
upsertConsumer({ consumer_id: TARGET_AGENT, kind: "agent" });

// Pre-create the `win` tag — the API resolves names to ids, but at the DB
// level we need a row.
const winTag = insertTag({ name: "win" });

// One rule covering BOTH triggers in union — the canonical david `8r7crj`
// pattern : "assign tickets carrying the win tag to aiball-windows whether
// the tag was there at creation OR added later".
insertAutomationRule({
    triggers: ["ticket_created", "ticket_tagged"],
    match_project: PROJECT,
    match_tags: ["win"],
    action: { kind: "assign", consumer_id: TARGET_AGENT },
    note: "win → windows agent",
});

// Sanity : the row landed AND comes back through the typed list.
const rules = listAutomationRules({ enabledOnly: true });
assert.equal(rules.length, 1, "automation rule seeded");
assert.deepEqual(rules[0]!.triggers, ["ticket_created", "ticket_tagged"]);
assert.equal(rules[0]!.action.kind, "assign");

test("scenario 1 : tag 'win' added to an existing ticket → auto-assigned", () => {
    const t = submitMessage({
        project: PROJECT,
        kind: "ticket_created",
        title: "scenario 1",
        body: "no tag at creation, win tag added next",
        by_agent: REPORTER,
    });
    assert.equal(t.status, "approved", "human author auto-approves");
    // Pre-state : no assignee.
    const fresh = getMessage(t.id);
    assert.equal(fresh?.assignee, null);

    // Add the win tag at the DB layer + emit the same lifecycle event the
    // tags.ts API handler would emit. The runtime subscribed at module load
    // picks this up and runs the assign action.
    addMessageTag(t.id, winTag.id, REPORTER);
    const allNames = listMessageTags(t.id).map((x) => x.name);
    emitLifecycle({
        op: "tagged",
        message: getMessage(t.id)!,
        added_tag: "win",
        all_tags: allNames,
    });

    const after = getMessage(t.id);
    assert.equal(after?.assignee, TARGET_AGENT, "rule fired → assigned");
    assert.equal(after?.assigned_by, "automation", "audit : assigned_by=automation");
});

test("scenario 2 : another project's ticket with the win tag is NOT touched", () => {
    const other = submitMessage({
        project: "sim-other",
        kind: "ticket_created",
        title: "scenario 2",
        body: "match_project narrows the rule",
        by_agent: REPORTER,
    });
    addMessageTag(other.id, winTag.id, REPORTER);
    emitLifecycle({
        op: "tagged",
        message: getMessage(other.id)!,
        added_tag: "win",
        all_tags: ["win"],
    });
    assert.equal(getMessage(other.id)?.assignee, null, "scope_project gates the rule");
});

test("scenario 3 : a tag other than 'win' doesn't fire the rule", () => {
    const t = submitMessage({
        project: PROJECT,
        kind: "ticket_created",
        title: "scenario 3",
        body: "different tag",
        by_agent: REPORTER,
    });
    const otherTag = insertTag({ name: "linux" });
    addMessageTag(t.id, otherTag.id, REPORTER);
    emitLifecycle({
        op: "tagged",
        message: getMessage(t.id)!,
        added_tag: "linux",
        all_tags: ["linux"],
    });
    assert.equal(getMessage(t.id)?.assignee, null, "match_tags any-of misses on 'linux'");
});

test("scenario 4 : ticket_created with no tags doesn't crash, just no-op", () => {
    // The runtime fires `ticket_created` automation as part of submitMessage's
    // `op="created"` emit. With `ticket_tags: []` at that point (tags are
    // applied AFTER the create), the `has_tags:[win]` condition misses — no
    // assignment, but no error either.
    const t = submitMessage({
        project: PROJECT,
        kind: "ticket_created",
        title: "scenario 4",
        body: "bare ticket",
        by_agent: REPORTER,
    });
    assert.equal(getMessage(t.id)?.assignee, null);
});

test("scenario 5 (slice 5.4) : multi-action stack — assign + set_priority both run", () => {
    // david `aa48pd` : "on doit pouvoir stack plusieurs actions". A rule
    // with `actions: [assign, set_priority]` must apply BOTH side-effects
    // on a single match. This pins the executeActions iteration.
    const triageAgent = "aiball-triage";
    upsertConsumer({ consumer_id: triageAgent, kind: "agent" });
    const triageTag = insertTag({ name: "triage" });
    insertAutomationRule({
        triggers: ["ticket_tagged"],
        match_project: PROJECT,
        match_tag_added: "triage",
        actions: [
            { kind: "assign", consumer_id: triageAgent },
            { kind: "set_priority", priority: "urgent" },
        ],
    });

    const t = submitMessage({
        project: PROJECT,
        kind: "ticket_created",
        title: "scenario 5",
        body: "to be triaged",
        by_agent: REPORTER,
    });
    assert.equal(getMessage(t.id)?.priority, "normal", "default priority before tag");

    addMessageTag(t.id, triageTag.id, REPORTER);
    emitLifecycle({
        op: "tagged",
        message: getMessage(t.id)!,
        added_tag: "triage",
        all_tags: ["triage"],
    });

    const after = getMessage(t.id);
    assert.equal(after?.assignee, triageAgent, "first action ran : assign");
    assert.equal(after?.priority, "urgent", "second action ran : set_priority");
});

test("scenario 6 (slice 5.4) : legacy single-`action` payload still wraps to actions[1]", () => {
    // Rules written with the legacy `action: …` field (pre-5.4 callers)
    // must keep working — rowToRule synthesizes `actions: [action]`.
    const r = insertAutomationRule({
        triggers: ["ticket_created"],
        action: { kind: "decision", decision: "auto" }, // legacy single
    });
    assert.deepEqual(r.actions, [{ kind: "decision", decision: "auto" }]);
    assert.equal(r.actions.length, 1);
    assert.deepEqual(r.action, r.actions[0]); // back-compat field mirrors the first
});

test("scenario 7 : a disabled rule never fires, even on a perfect match", () => {
    // Use a fresh tag so we know our existing rule isn't accidentally firing
    // on the win-tag path from earlier tests.
    const beta = insertTag({ name: "beta" });
    const targetB = "aiball-beta-agent";
    upsertConsumer({ consumer_id: targetB, kind: "agent" });
    const rule = insertAutomationRule({
        triggers: ["ticket_tagged"],
        match_project: PROJECT,
        match_tag_added: "beta",
        action: { kind: "assign", consumer_id: targetB },
    });
    // Flip it off via the same API the UI uses.
    setAutomationRuleEnabled(rule.id, false);

    const t = submitMessage({
        project: PROJECT,
        kind: "ticket_created",
        title: "scenario 5",
        body: "disabled rule",
        by_agent: REPORTER,
    });
    addMessageTag(t.id, beta.id, REPORTER);
    emitLifecycle({
        op: "tagged",
        message: getMessage(t.id)!,
        added_tag: "beta",
        all_tags: ["beta"],
    });
    assert.equal(getMessage(t.id)?.assignee, null, "disabled rule skipped");
});

after(() => {
    try {
        rmSync(process.env.AIBALL_HOME!, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

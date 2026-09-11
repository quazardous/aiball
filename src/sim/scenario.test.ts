/**
 * Board simulator scenarios: the file format, `$name` substitution, and the
 * matching that decides whether a run passes. A matcher that cannot fail makes
 * every scenario green, so each expectation is also checked against a seat
 * that contradicts it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSeat, parseDuration, parseScenario, pick, scenarioCohort, substitute, type Seat } from "./scenario.js";
import type { ViewRow } from "./view.js";

const AGENTS = ["alpha-lead", "alpha-helper"];

test("a scenario reads agent gestures, moderator gestures, views, expectations, wakes, sleeps and pauses", () => {
    const s = parseScenario(`
name: demo
cohort: tests/sim/cohorts/two-owners.yaml
steps:
  - alpha-lead: ticket_new
    args: { title: t }
    save: { ticket: id }
  - moderator: approve $ticket
  - alpha-lead: ticket_reply
    args: { target_id: $ticket, body: b, summary_until: s, handback: false }
    refused: claim it first
  - moderator: comment $ticket
    body: hello
  - view: [alpha-lead, alpha-helper]
  - expect:
      alpha-lead: { ticket: $ticket, backlog: actionable, act: true, wake: triage, rank: 1, events: [plan_accepted] }
  - wake: alpha-lead
  - sleep: 2m
  - moderator: snooze $ticket 90s
  - moderator: assign $ticket alpha-helper
  - moderator: close $ticket
    may_fail: true
  - pause: look
`, AGENTS);
    assert.equal(s.cohort, "tests/sim/cohorts/two-owners.yaml");
    assert.deepEqual(s.steps.map((x) => x.kind), ["mcp", "moderator", "mcp", "moderator", "view", "expect", "wake", "sleep", "moderator", "moderator", "moderator", "pause"]);
    assert.deepEqual(s.steps[0], { kind: "mcp", agent: "alpha-lead", tool: "ticket_new", args: { title: "t" }, save: { ticket: "id" }, refused: null });
    assert.deepEqual(s.steps[1], { kind: "moderator", action: "approve", target: "$ticket", arg: null, body: null, mayFail: false });
    assert.equal((s.steps[2] as { refused: string }).refused, "claim it first");
    assert.deepEqual(s.steps[6], { kind: "wake", agent: "alpha-lead" });
    assert.deepEqual(s.steps[7], { kind: "sleep", seconds: 120 });
    assert.deepEqual(s.steps[8], { kind: "moderator", action: "snooze", target: "$ticket", arg: "90s", body: null, mayFail: false });
    assert.deepEqual(s.steps[9], { kind: "moderator", action: "assign", target: "$ticket", arg: "alpha-helper", body: null, mayFail: false });
    assert.equal((s.steps[10] as { mayFail: boolean }).mayFail, true);
    assert.equal(scenarioCohort("name: x\nsteps: []"), null, "no cohort: the default one");
});

test("a scenario naming someone outside the cohort, or an unknown gesture, is refused before anything runs", () => {
    assert.throws(() => parseScenario("name: x\nsteps:\n  - stranger: poll", AGENTS), /unknown agent stranger/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: merge 1", AGENTS), /moderator action/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: comment 1", AGENTS), /needs a body/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: snooze 1", AGENTS), /snooze \$ticket <duration>/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: assign 1 stranger", AGENTS), /unknown agent stranger/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - sleep: soon", AGENTS), /sleep takes a duration/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - expect: { alpha-lead: { ticket: 1, backlog: nowhere } }", AGENTS), /backlog must be/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - expect: { alpha-lead: { ticket: 1, rank: -1 } }", AGENTS), /rank is a position/);
    assert.throws(() => parseScenario("steps:\n  - view: alpha-lead", AGENTS), /name is required/);
});

test("durations read as seconds, and nothing else passes for one", () => {
    assert.equal(parseDuration("45"), 45);
    assert.equal(parseDuration("45s"), 45);
    assert.equal(parseDuration("2m"), 120);
    assert.equal(parseDuration("1h"), 3600);
    assert.equal(parseDuration("2 days"), null);
});

test("$name is replaced however deep, and an unsaved one stops the run", () => {
    assert.deepEqual(substitute({ a: "$t", b: ["$t", "x$t"], c: { d: "$t" } }, { t: 7 }), { a: 7, b: [7, "x$t"], c: { d: 7 } });
    assert.throws(() => substitute({ a: "$nope" }, {}), /not saved yet/);
    assert.equal(pick({ claim: { claimant: "a" } }, "claim.claimant"), "a");
    assert.equal(pick({ id: 3 }, "missing.path"), undefined);
});

const row = (over: Partial<ViewRow>): ViewRow => ({
    id: 1, title: "t", actionable: false, claimable: false, backlog_tier: null,
    gated_by_decision: false, last_actor: null, ...over,
});
const seat = (over: Partial<Seat>): Seat => ({ rows: [], unreadPings: 0, head: null, unread: [], ...over });

test("a seat that matches passes, and each field that differs is named", () => {
    const mine = row({ id: 1, actionable: true, claimable: true, backlog_tier: 1, last_actor: "alpha-lead" });
    const s = seat({ rows: [row({ id: 5 }), mine], head: mine, unreadPings: 0 });
    assert.deepEqual(matchSeat({ ticket: 1, backlog: "actionable", act: true, claim: true, gated: false, last_actor: "alpha-lead", wake: "triage", rank: 2 }, s), []);

    const misses = matchSeat({ ticket: 1, backlog: "waiting", act: false, claim: false, gated: true, last_actor: "david", rank: 1, wake: "waiting" }, s);
    assert.deepEqual(misses.map((m) => m.split(":")[0]), ["backlog", "act", "claim", "gated", "last_actor", "rank", "wake"]);
});

test("rank is the position in the work order, and 0 means the agent does not list the ticket", () => {
    const s = seat({ rows: [row({ id: 3 }), row({ id: 1 })] });
    assert.deepEqual(matchSeat({ ticket: 3, rank: 1 }, s), []);
    assert.deepEqual(matchSeat({ ticket: 9, rank: 0 }, s), []);
    assert.match(matchSeat({ ticket: 1, rank: 1 }, s)[0]!, /rank: expected 1, got 2/);
});

test("events are this ticket's unread kinds, oldest first, a creation counting as its own ticket", () => {
    const s = seat({
        unreadPings: 3,
        unread: [
            { id: 1, kind: "ticket_created", ticket_id: null },
            { id: 1000, kind: "plan_accepted", ticket_id: 1 },
            { id: 1001, kind: "comment_added", ticket_id: 2 },
        ],
    });
    assert.deepEqual(matchSeat({ ticket: 1, events: ["ticket_created", "plan_accepted"] }, s), []);
    assert.deepEqual(matchSeat({ ticket: 3, events: [] }, s), []);
    assert.match(matchSeat({ ticket: 1, events: ["plan_accepted"] }, s)[0]!, /events: expected \[plan_accepted\], got \[ticket_created, plan_accepted\]/);
});

test("the wake is about THIS ticket: pings come first, and another head is not this ticket's wake", () => {
    const other = row({ id: 2, backlog_tier: 1 });
    const mine = row({ id: 1, backlog_tier: 3 });
    assert.deepEqual(matchSeat({ ticket: 1, wake: "event" }, seat({ rows: [mine], unreadPings: 1, head: other })), []);
    assert.match(matchSeat({ ticket: 1, wake: "waiting" }, seat({ rows: [mine, other], head: other }))[0]!, /got about #2/);
    assert.deepEqual(matchSeat({ ticket: 1, wake: "none" }, seat({ rows: [mine, other], head: other })), []);
    assert.deepEqual(matchSeat({ ticket: 1, wake: "none", backlog: "none" }, seat({})), []);
});

test("expecting a ticket the agent cannot see says so", () => {
    assert.match(matchSeat({ ticket: 9, act: true }, seat({})).join(" | "), /not among the open tickets/);
});

/**
 * Board simulator scenarios: the file format, `$name` substitution, and the
 * matching that decides whether a run passes. A matcher that cannot fail makes
 * every scenario green, so each expectation is also checked against a seat
 * that contradicts it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSeat, parseScenario, pick, substitute, type Seat } from "./scenario.js";
import type { ViewRow } from "./view.js";

const AGENTS = ["alpha-lead", "alpha-helper"];

test("a scenario reads agent gestures, moderator gestures, views, expectations and pauses", () => {
    const s = parseScenario(`
name: demo
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
      alpha-lead: { ticket: $ticket, backlog: actionable, act: true, wake: triage }
  - wake: alpha-lead
  - pause: look
`, AGENTS);
    assert.deepEqual(s.steps.map((x) => x.kind), ["mcp", "moderator", "mcp", "moderator", "view", "expect", "wake", "pause"]);
    assert.deepEqual(s.steps[6], { kind: "wake", agent: "alpha-lead" });
    assert.deepEqual(s.steps[0], { kind: "mcp", agent: "alpha-lead", tool: "ticket_new", args: { title: "t" }, save: { ticket: "id" }, refused: null });
    assert.deepEqual(s.steps[1], { kind: "moderator", action: "approve", target: "$ticket", body: null });
    assert.equal((s.steps[2] as { refused: string }).refused, "claim it first");
});

test("a scenario naming someone outside the cohort, or an unknown gesture, is refused before anything runs", () => {
    assert.throws(() => parseScenario("name: x\nsteps:\n  - stranger: poll", AGENTS), /unknown agent stranger/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: close 1", AGENTS), /moderator action/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - moderator: comment 1", AGENTS), /needs a body/);
    assert.throws(() => parseScenario("name: x\nsteps:\n  - expect: { alpha-lead: { ticket: 1, backlog: nowhere } }", AGENTS), /backlog must be/);
    assert.throws(() => parseScenario("steps:\n  - view: alpha-lead", AGENTS), /name is required/);
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

test("a seat that matches passes, and each field that differs is named", () => {
    const mine = row({ id: 1, actionable: true, claimable: true, backlog_tier: 1, last_actor: "alpha-lead" });
    const seat: Seat = { rows: [mine], unreadPings: 0, head: mine };
    assert.deepEqual(matchSeat({ ticket: 1, backlog: "actionable", act: true, claim: true, gated: false, last_actor: "alpha-lead", wake: "triage" }, seat), []);

    const misses = matchSeat({ ticket: 1, backlog: "waiting", act: false, claim: false, gated: true, last_actor: "david", wake: "waiting" }, seat);
    assert.deepEqual(misses.map((m) => m.split(":")[0]), ["backlog", "act", "claim", "gated", "last_actor", "wake"]);
});

test("the wake is about THIS ticket: pings come first, and another head is not this ticket's wake", () => {
    const other = row({ id: 2, backlog_tier: 1 });
    const mine = row({ id: 1, backlog_tier: 3 });
    assert.deepEqual(matchSeat({ ticket: 1, wake: "event" }, { rows: [mine], unreadPings: 1, head: other }), []);
    assert.match(matchSeat({ ticket: 1, wake: "waiting" }, { rows: [mine, other], unreadPings: 0, head: other })[0]!, /got about #2/);
    assert.deepEqual(matchSeat({ ticket: 1, wake: "none" }, { rows: [mine, other], unreadPings: 0, head: other }), []);
    assert.deepEqual(matchSeat({ ticket: 1, wake: "none", backlog: "none" }, { rows: [], unreadPings: 0, head: null }), []);
});

test("expecting a ticket the agent cannot see says so", () => {
    assert.match(matchSeat({ ticket: 9, act: true }, { rows: [], unreadPings: 0, head: null }).join(" | "), /not among the open tickets/);
});

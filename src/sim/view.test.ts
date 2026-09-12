/**
 * The board simulator (tests/sim) tells what an agent's next wake would say.
 * It is only worth reading if it says what the loop says: the wake endings are
 * held here to the loop's own template, so a change to one without the other
 * turns this test red. Also covers the cohort file's rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WAKE_ENDING, formatView, nextWake, wakeEnding, type ViewRow } from "./view.js";
import { parseCohort } from "./cohort.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("every wake ending the simulator prints is the loop's own wording", () => {
    const template = readFileSync(join(ROOT, "src/claude-loop/state.ts"), "utf8");
    for (const [key, ending] of Object.entries(WAKE_ENDING)) {
        assert.ok(template.includes(`{head_tier_${key}:+ ${ending}}`), `state.ts no longer ends a ${key} wake with: ${ending}`);
    }
});

/**
 * #2405 david — the test above held the simulator to `state.ts`, which is only
 * the FALLBACK: the shipped `wake_master` slot wins whenever it exists, and it
 * does. So a wording could be decided, committed, delivered and still never
 * reach a single agent — which is exactly what happened to the tier endings.
 * The wake an agent reads comes from this file; hold it too.
 */
test("the SHIPPED wake template carries those same endings — it is what agents read", () => {
    const shipped = readFileSync(join(ROOT, "config/defaults/claude-loop-pings.yaml"), "utf8");
    for (const [key, ending] of Object.entries(WAKE_ENDING)) {
        assert.ok(
            shipped.includes(`{head_tier_${key}:+ ${ending}}`),
            `config/defaults/claude-loop-pings.yaml no longer ends a ${key} wake with: ${ending}`,
        );
    }
});

test("the wake ending follows the head's tier, as the loop maps it", () => {
    // #2376 — a head in my court whose own `then:` still waits is asked to
    // confirm or amend it, not to triage from scratch.
    assert.equal(wakeEnding(1, true), WAKE_ENDING.confirm);
    assert.equal(wakeEnding(null, true), WAKE_ENDING.confirm);
    assert.equal(wakeEnding(3, true), WAKE_ENDING.waiting, "only a head in my court confirms");
    assert.equal(wakeEnding(null), WAKE_ENDING.triage);
    assert.equal(wakeEnding(0), WAKE_ENDING.triage);
    assert.equal(wakeEnding(1), WAKE_ENDING.triage);
    assert.equal(wakeEnding(2), WAKE_ENDING.followup);
    assert.equal(wakeEnding(3), WAKE_ENDING.waiting);
    assert.equal(wakeEnding(4), WAKE_ENDING.blocked);
});

const row = (over: Partial<ViewRow>): ViewRow => ({
    id: 1, title: "t", actionable: false, claimable: false, backlog_tier: null,
    gated_by_decision: false, last_actor: null, ...over,
});

test("unread pings wake first; then the backlog head; else nothing", () => {
    assert.match(nextWake(2, row({ backlog_tier: 1 })), /^event wake: 2 unread pings first$/);
    assert.equal(nextWake(0, row({ id: 7, title: "x", backlog_tier: 3 })), `look #7: x. ${WAKE_ENDING.waiting}`);
    assert.match(nextWake(0, null), /^no wake/);
});

test("the seat lists the backlog by tier, then the open tickets outside it", () => {
    const out = formatView("a", [
        row({ id: 5, title: "outside" }),
        row({ id: 9, title: "waiting", backlog_tier: 3, last_actor: "a" }),
        row({ id: 2, title: "mine", backlog_tier: 1, actionable: true }),
    ], 0, row({ id: 2, title: "mine", backlog_tier: 1 }));
    const order = ["mine", "waiting", "outside"].map((t) => out.indexOf(` ${t}`));
    assert.deepEqual([...order].sort((x, y) => x - y), order, out);
    assert.match(out, /next: look #2: mine\. Triage it, then close the loop:/);
});

test("a cohort declares a moderator, projects with leads, and followers of known projects", () => {
    const c = parseCohort(`
moderator: { id: david, password: simulator }
projects:
  alpha: { lead: alpha-lead }
agents:
  - { id: helper, project: alpha }
`);
    assert.deepEqual(c.agents, [
        { id: "alpha-lead", project: "alpha", role: "owner", canClaim: true },
        { id: "helper", project: "alpha", role: "follower", canClaim: true },
    ]);
    assert.equal(parseCohort("moderator: { id: d, password: simulator }\nprojects: { a: {} }\nagents: [{ id: crew, project: a, can_claim: false }]").agents[0]!.canClaim, false);
    assert.throws(() => parseCohort("moderator: { id: d, password: simulator }\nprojects: { a: {} }\nagents: [{ id: crew, project: a, can_claim: nope }]"), /can_claim must be/);
    assert.throws(() => parseCohort("moderator: { id: d, password: x }\nprojects: { a: {} }"), /password/);
    assert.throws(() => parseCohort("moderator: { id: d, password: simulator }\nprojects: { a: { lead: d } }"), /declared twice/);
    assert.throws(() => parseCohort("moderator: { id: d, password: simulator }\nprojects: { a: {} }\nagents: [{ id: x, project: b }]"), /unknown project/);
});

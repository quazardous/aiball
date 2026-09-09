/**
 * #2172 — the refusals of `aiball project move`.
 *
 * The decisions are the interesting half of this command; the loop that does
 * the moving is `moveTicket` called N times, and that is already covered where
 * it lives. What is new here is when the command declines — and one refusal in
 * particular carries the whole distinction with `rename`: a target that does
 * not exist is NOT created, it is a pointer at the other command.
 *
 * `die()` exits the process, so these rules are only observable as a verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { planProjectMove, MOVE_CONFIRM_THRESHOLD } = await import("./admin.js");

const KNOWN = ["alpha", "beta"];
const plan = (over: Partial<Parameters<typeof planProjectMove>[0]> = {}) =>
    planProjectMove({ source: "alpha", target: "beta", known: KNOWN, ticketCount: 3, yes: false, ...over });

test("folding a project into itself is refused before any query", () => {
    assert.equal(plan({ target: "alpha" }).kind, "same");
});

test("an unknown source is named, not silently treated as empty", () => {
    const v = plan({ source: "ghost" });
    assert.equal(v.kind, "no-source");
    assert.equal(v.kind === "no-source" && v.name, "ghost");
});

test("a target that does not exist points at `rename` — it is NOT created", () => {
    // The distinction the whole command rests on. `rename` already handles the
    // empty-destination case and refuses when the destination is occupied;
    // creating the target here would make the two commands overlap and give
    // `move` a way to silently invent a project on a typo.
    const v = plan({ target: "nouveau" });
    assert.equal(v.kind, "no-target");
    assert.equal(v.kind === "no-target" && v.name, "nouveau");
});

test("an empty source is a no-op, not an error", () => {
    assert.equal(plan({ ticketCount: 0 }).kind, "empty");
});

test("past the threshold it demands --yes, and takes it", () => {
    const many = MOVE_CONFIRM_THRESHOLD + 1;
    assert.equal(plan({ ticketCount: many }).kind, "needs-confirm");
    assert.equal(plan({ ticketCount: many, yes: true }).kind, "go");
});

test("at the threshold exactly it still goes — the guard is for BULK", () => {
    // Off-by-one on a confirmation prompt is the kind of thing nobody notices
    // until it blocks a three-ticket fold, or waves a fifty-ticket one through.
    assert.equal(plan({ ticketCount: MOVE_CONFIRM_THRESHOLD }).kind, "go");
    assert.equal(plan({ ticketCount: MOVE_CONFIRM_THRESHOLD + 1 }).kind, "needs-confirm");
});

test("--yes does not resurrect a refusal that is not about size", () => {
    // A confirmation flag that also silences \"this project does not exist\"
    // would turn a typo into a surprise.
    assert.equal(plan({ source: "ghost", yes: true }).kind, "no-source");
    assert.equal(plan({ target: "nouveau", yes: true }).kind, "no-target");
    assert.equal(plan({ target: "alpha", yes: true }).kind, "same");
});

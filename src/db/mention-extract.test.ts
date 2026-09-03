// #1992 — the mention extractor. Every noise case below is a REAL string taken
// from the corpus while measuring precision, not an invented one: the guard was
// written from the false positives it had to kill, so the tests are the
// evidence for the constants the module ships.
import test from "node:test";
import assert from "node:assert/strict";
import { extractMentions, MIN_TICKET_REF } from "./mention-extract.js";

const ids = (text: string) => extractMentions(text).map((m) => m.ticketId);

test("finds the plain reference", () => {
    assert.deepEqual(ids("this gates #1628, see also #1631"), [1628, 1631]);
});

test("repeats are kept — the caller weighs them", () => {
    // A pair named once is often decoration; twice is a link. That judgement
    // belongs to the caller, so the extractor must not dedupe for it.
    assert.deepEqual(ids("#1628 and again #1628"), [1628, 1628]);
});

test("the offset points at the '#' so an edge can cite its sentence", () => {
    const [m] = extractMentions("bloqué par #1631 depuis hier");
    assert.equal(m.offset, 11);
    assert.equal("bloqué par #1631 depuis hier".slice(m.offset, m.offset + 5), "#1631");
});

test("a pull-request number is not a ticket", () => {
    // "PR #326" — the single most common false positive in the corpus.
    assert.deepEqual(ids("Si je la supprime le nouveau PR #326 perd son head"), []);
    assert.deepEqual(ids("merge request #1234 is green"), []);
    assert.deepEqual(ids("issue #4012 upstream"), []);
});

test("a line number is not a ticket", () => {
    // "= la vraie ligne #404" — the other measured shape.
    assert.deepEqual(ids("top_token_tickets: [ #404 ] = la vraie ligne #404"), [404]);
});

test("a repo reference is not a ticket, with or without a host", () => {
    // "gh:quazardous/aiball#86 → github quazardous/aiball#86" — the corpus
    // writes both forms, and the short one carries no host for a word-based
    // guard to find. What identifies it is the path glued to the `#`.
    assert.deepEqual(ids("voir github.com/quazardous/aiball#1832"), []);
    assert.deepEqual(ids("gh:quazardous/aiball#1832"), []);
    assert.deepEqual(ids("quazardous/aiball#1832"), []);
    // …while a path merely NEAR a ref leaves it alone: the space breaks the glue.
    assert.deepEqual(ids("src/api/tickets.ts fixes #1832"), [1832]);
});

test("two-digit refs are dropped: measured ~50% wrong even with the guard", () => {
    // "merger #43", "`761fb8c` #10" — PR and commit sequences. The floor costs
    // the 99 tickets numbered under 100, all ancient; that trade is the point.
    assert.deepEqual(ids("mon vote : merger #43 quand tu veux"), []);
    assert.deepEqual(ids("#8 → #9 → #10"), []);
    assert.equal(MIN_TICKET_REF, 100);
    assert.deepEqual(ids(`#${MIN_TICKET_REF - 1}`), []);
    assert.deepEqual(ids(`#${MIN_TICKET_REF}`), [MIN_TICKET_REF]);
});

test("existence is not this function's question", () => {
    // Whether #99999 is a ticket is a question for the corpus. Keeping the
    // lookup out is what keeps this module free of a DB.
    assert.deepEqual(ids("#99999"), [99999]);
});

test("empty and absent text yield nothing, not a throw", () => {
    for (const v of [null, undefined, "", "no refs here"]) {
        assert.deepEqual(extractMentions(v), []);
    }
});

test("the regex is not left mid-scan between calls", () => {
    // A module-level /g regex keeps `lastIndex` across calls; forgetting to
    // reset it makes the SECOND call skip the start of its text — a bug that
    // only shows up in a batch, which is exactly how the compiler runs.
    const once = ids("#1628 #1631");
    assert.deepEqual(ids("#1628 #1631"), once);
    assert.deepEqual(once, [1628, 1631]);
});

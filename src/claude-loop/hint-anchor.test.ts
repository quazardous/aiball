/**
 * #1582 — a wake may only anchor on a hint that has something to render.
 *
 * The bug this pins: a `ticket_sub_added` hint (a bodyless pseudo-comment
 * recording a sub-ticket on its parent's thread) anchored the wake and rendered
 * its empty body, producing a wake that read, in full, `(#1571 / #edxf9s)`.
 *
 * The old guard listed the kinds it believed to be bodyless. This one asks
 * whether there is text — which is why adding a new bodyless kind cannot
 * reopen the hole, and why no test here needs to enumerate kinds.
 *
 * Run: `npx tsx --test src/claude-loop/hint-anchor.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { headTextFor, hintHasRenderableBody } from "./state.js";

test("a hint carrying real text may anchor", () => {
    assert.equal(hintHasRenderableBody({ commentBody: "Revue faite, deux remarques." }), true);
});

test("the shapes that produced the bare-refs wake cannot anchor", () => {
    // `ticket_sub_added` / `ticket_referenced`: body is '' by construction.
    assert.equal(hintHasRenderableBody({ commentBody: "" }), false);
    // Lifecycle rows store NULL rather than '' — same emptiness, other spelling.
    assert.equal(hintHasRenderableBody({ commentBody: undefined }), false);
    // wake-context failed and returned neither kind nor body: the old guard
    // treated the unknown kind as "unchanged behaviour" and anchored on nothing.
    assert.equal(hintHasRenderableBody({}), false);
    assert.equal(hintHasRenderableBody(undefined), false);
});

test("whitespace is not content", () => {
    // A body stripped down to its markdown scaffolding renders as nothing at
    // all, which is the same wake failure with a fuller-looking payload.
    assert.equal(hintHasRenderableBody({ commentBody: "   " }), false);
    assert.equal(hintHasRenderableBody({ commentBody: "\n\n\t " }), false);
});

test("the guarantee holds for a kind that does not exist yet", () => {
    // The point of testing content instead of kind: this hint carries a kind
    // nobody has written a rule for. It still cannot anchor on an empty body,
    // and it still can when it has one.
    assert.equal(hintHasRenderableBody({ commentBody: "" }), false);
    assert.equal(hintHasRenderableBody({ commentBody: "something to say" }), true);
});

// =====================================================================
// #1582, the FIFO half — a comment-centric head must carry text
// =====================================================================

test("a body renders, stripped", () => {
    assert.equal(headTextFor("**gras** et suite", "comment", "comment_added"), "gras et suite");
});

test("the bodyless pseudo-comments fall back to their label, never to nothing", () => {
    // `ticket_sub_added` is what produced `(#1571 / #s34tvh)` in production.
    assert.equal(headTextFor("", "sub-ticket added", "ticket_sub_added"), "sub-ticket added");
    assert.equal(headTextFor(null, "referenced", "ticket_referenced"), "referenced");
});

test("an unlabelled kind falls back to the kind itself — still not empty", () => {
    // The guarantee has to hold for a kind nobody has labelled yet, which is
    // exactly how the two above slipped through a hand-kept list.
    assert.equal(headTextFor("", undefined, "some_future_kind"), "some_future_kind");
    assert.equal(headTextFor("   ", undefined, "some_future_kind"), "some_future_kind");
});

test("with neither body, label nor kind it still says something", () => {
    assert.equal(headTextFor("", undefined, ""), "update");
    assert.equal(headTextFor(undefined, undefined, ""), "update");
});

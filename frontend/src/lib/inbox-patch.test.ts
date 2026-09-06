// #2072 — the patch-or-refetch rule.
//
// What these pin is the BIAS. The browser holds 25 rows out of two thousand, so
// it cannot judge membership on its own; every case where it cannot prove that
// only a row's content moved has to fall back to re-reading the page. A wrong
// `patch` shows a list that quietly disagrees with the server, which is worse
// than one extra page read.
import test from "node:test";
import assert from "node:assert/strict";
import { decideInboxUpdate } from "./inbox-patch";

const ctx = (...visible: number[]) => ({ visible: new Set(visible) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const msg = (kind: string, ticket_id: number | null, id = 999) => ({ kind, ticket_id, id }) as any;

test("a comment on a visible ticket touches just that row", () => {
    assert.deepEqual(
        decideInboxUpdate(msg("comment_added", 42), ctx(42, 7)),
        { kind: "patch", ticketId: 42 },
    );
});

test("a comment on a ticket NOT on screen re-reads the page", () => {
    // In activity order it should jump to the top and push another row off.
    // The browser cannot know that — it has never seen the row.
    assert.deepEqual(decideInboxUpdate(msg("comment_added", 1234), ctx(42, 7)), { kind: "refetch" });
});

test("a new ticket re-reads the page — it can land anywhere in the order", () => {
    assert.deepEqual(decideInboxUpdate(msg("ticket_created", null, 500), ctx(42)), { kind: "refetch" });
});

test("closing and reopening change membership, even on a visible row", () => {
    // Under an open-only view a close drops the row out, and something from
    // page 2 slides in to take its place.
    assert.deepEqual(decideInboxUpdate(msg("ticket_closed", 42), ctx(42)), { kind: "refetch" });
    assert.deepEqual(decideInboxUpdate(msg("ticket_reopened", 42), ctx(42)), { kind: "refetch" });
});

test("a message pointing at no ticket re-reads rather than guessing", () => {
    assert.deepEqual(decideInboxUpdate(msg("message_edited", null), ctx(42)), { kind: "refetch" });
});

test("nothing at all is ignored, not turned into a refetch", () => {
    assert.deepEqual(decideInboxUpdate(null, ctx(42)), { kind: "ignore" });
    assert.deepEqual(decideInboxUpdate(undefined, ctx(42)), { kind: "ignore" });
});

test("an empty page re-reads: nothing is visible, so nothing can be patched", () => {
    assert.deepEqual(decideInboxUpdate(msg("comment_added", 42), ctx()), { kind: "refetch" });
});

test("a decision event on a visible row is a content change", () => {
    // plan_accepted, resolution_rejected… they repaint the row's badges, they
    // don't move it in or out of the page.
    for (const k of ["plan_accepted", "resolution_rejected", "wontfix_accepted", "message_tagged"]) {
        assert.deepEqual(
            decideInboxUpdate(msg(k, 42), ctx(42)),
            { kind: "patch", ticketId: 42 },
            `${k} should patch`,
        );
    }
});

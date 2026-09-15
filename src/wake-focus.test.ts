// #2525 — the wake focus: parsing, the active check, the per-ticket verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFocus, describeFocus, focusHides, parseFocusTickets } from "./wake-focus.js";

test("a list keeps only those tickets; a !list keeps everything but them", () => {
    assert.deepEqual(parseFocusTickets("123, 456"), { mode: "only", ids: [123, 456] });
    assert.deepEqual(parseFocusTickets("#123 #456;123"), { mode: "only", ids: [123, 456] });
    assert.deepEqual(parseFocusTickets("!789, !#790"), { mode: "except", ids: [789, 790] });
});

test("mixing both forms, a non-ticket and an empty list are refused with the reason", () => {
    assert.match((parseFocusTickets("123, !789") as { error: string }).error, /mixes/);
    assert.match((parseFocusTickets("123, abc") as { error: string }).error, /"abc" is not a ticket/);
    assert.match((parseFocusTickets("  ") as { error: string }).error, /no ticket/);
});

test("a focus past its end, or unreadable, is no focus", () => {
    const now = Date.parse("2026-09-15T10:00:00Z");
    assert.equal(activeFocus({ tickets: "1", until: "2026-09-15T09:59:59Z" }, now), null);
    assert.ok(activeFocus({ tickets: "1", until: "2026-09-15T10:00:01Z" }, now));
    assert.ok(activeFocus({ tickets: "1", until: null }, now));
    assert.equal(activeFocus({ tickets: "1, !2", until: null }, now), null);
    assert.equal(activeFocus(null, now), null);
});

test("the verdict and the line the wake opens with", () => {
    const only = activeFocus({ tickets: "456, 123", until: null }, 0);
    assert.equal(focusHides(only, 123), false);
    assert.equal(focusHides(only, 999), true);
    assert.equal(describeFocus(only), "focus: #123, #456 only");
    const except = activeFocus({ tickets: "!789", until: null }, 0);
    assert.equal(focusHides(except, 789), true);
    assert.equal(focusHides(except, 1), false);
    assert.equal(describeFocus(except), "focus: all but #789");
    assert.equal(focusHides(null, 1), false);
    assert.equal(describeFocus(null), "");
});

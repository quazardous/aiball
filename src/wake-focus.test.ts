// #2525 — the wake focus: parsing, the active check, the per-ticket verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeFocus, describeFocus, expandFocus, focusHides, parseFocusTickets, type FocusRelatives } from "./wake-focus.js";

test("a list keeps only those tickets; a !list keeps everything but them", () => {
    assert.deepEqual(parseFocusTickets("123, 456"), { mode: "only", ids: [123, 456], specs: [{ id: 123, up: 0, down: 0, linked: false }, { id: 456, up: 0, down: 0, linked: false }] });
    assert.deepEqual((parseFocusTickets("#123 #456;123") as { ids: number[] }).ids, [123, 456]);
    assert.deepEqual(parseFocusTickets("!789, !#790"), { mode: "except", ids: [789, 790], specs: [{ id: 789, up: 0, down: 0, linked: false }, { id: 790, up: 0, down: 0, linked: false }] });
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

// #2757 — relatives. The graph: 10 has children 11 and 12; 11 has child 13;
// 10's parent is 9, whose parent is 8; 20 is linked to 10 (a plain relation).
const GRAPH: Record<number, FocusRelatives> = {
    8: { children: [9], parents: [], linked: [9] },
    9: { children: [10], parents: [8], linked: [8, 10] },
    10: { children: [11, 12], parents: [9], linked: [9, 11, 12, 20] },
    11: { children: [13], parents: [10], linked: [10, 13] },
    12: { children: [], parents: [10], linked: [10] },
    13: { children: [], parents: [11], linked: [11] },
    20: { children: [], parents: [], linked: [10] },
};
const rel = (id: number): FocusRelatives => GRAPH[id] ?? { children: [], parents: [], linked: [] };
const resolve = (text: string): number[] => {
    const p = parseFocusTickets(text);
    if ("error" in p) throw new Error(p.error);
    return [...expandFocus(p.specs, rel)].sort((a, b) => a - b);
};

test("#2757 123+ direct children, 123++ every descendant", () => {
    assert.deepEqual(resolve("10+"), [10, 11, 12]);
    assert.deepEqual(resolve("10++"), [10, 11, 12, 13]);
});

test("#2757 +123 direct parent, ++123 every ancestor, both sides together", () => {
    assert.deepEqual(resolve("+10"), [9, 10]);
    assert.deepEqual(resolve("++10"), [8, 9, 10]);
    assert.deepEqual(resolve("+10+"), [9, 10, 11, 12]);
});

test("#2757 123~ every ticket directly linked, and nothing further", () => {
    assert.deepEqual(resolve("10~"), [9, 10, 11, 12, 20]);
});

test("#2757 operators combine with ! and with plain tickets", () => {
    const except = activeFocus({ tickets: "!10++", until: null }, 0, rel)!;
    assert.equal(except.mode, "except");
    assert.equal(focusHides(except, 13), true, "a grandchild is left out with its ancestor");
    assert.equal(focusHides(except, 9), false);
    assert.deepEqual(resolve("10+, 20"), [10, 11, 12, 20]);
    assert.equal(describeFocus(activeFocus({ tickets: "++10, 20~, 11+", until: null }, 0, rel)), "focus: ++#10, #11+, #20~ only");
});

test("#2757 without a relatives reader, the list is taken literally", () => {
    const f = activeFocus({ tickets: "10++", until: null }, 0)!;
    assert.deepEqual([...f.ids], [10]);
});

test("#2757 malformed operators are refused, with the notation in the message", () => {
    for (const bad of ["10+++", "10~~", "~10", "10+~", "+++10"]) {
        const p = parseFocusTickets(bad);
        assert.ok("error" in p, `${bad} should be refused`);
        assert.match((p as { error: string }).error, /123\+\+ all its descendants/);
    }
});


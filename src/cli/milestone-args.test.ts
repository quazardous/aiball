/**
 * #2910 — `aiball --human ticket milestone <milestone> <ids…>`: the milestone is
 * named by its version, its id, or `none`; the tickets by their ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMilestoneArg, parseTicketIds, resolveMilestone } from "./milestone-args.js";

test("the milestone is a version, an id, or none", () => {
    assert.deepEqual(parseMilestoneArg("0.3"), { kind: "title", title: "0.3" });
    assert.deepEqual(parseMilestoneArg("octopod 1.0"), { kind: "title", title: "octopod 1.0" });
    assert.deepEqual(parseMilestoneArg("#2932"), { kind: "id", id: 2932 });
    assert.deepEqual(parseMilestoneArg("2932"), { kind: "id", id: 2932 });
    assert.deepEqual(parseMilestoneArg("None"), { kind: "none" });
});

test("tickets come space- or comma-separated, with or without #, once each", () => {
    assert.deepEqual(parseTicketIds(["2929", "#2930", "2931,2932", "2929"]), [2929, 2930, 2931, 2932]);
    assert.deepEqual(parseTicketIds(["2929", "abc"]), { error: '"abc" is not a ticket id' });
    assert.deepEqual(parseTicketIds([]), { error: "no ticket to put in the milestone" });
});

test("a version resolves to the one open milestone of that name", () => {
    const ms = [
        { id: 10, title: "0.2", released: true },
        { id: 11, title: "0.3", released: false },
        { id: 12, title: "1.0", released: false },
    ];
    assert.equal(resolveMilestone({ kind: "title", title: "0.3" }, ms), 11);
    assert.equal(resolveMilestone({ kind: "none" }, ms), null);
    assert.equal(resolveMilestone({ kind: "id", id: 12 }, ms), 12);
    assert.match((resolveMilestone({ kind: "title", title: "0.2" }, ms) as { error: string }).error, /no open milestone named "0.2"; open ones: 0.3 \(#11\), 1.0 \(#12\)/);
    const dup = [...ms, { id: 13, title: "0.3", released: false }];
    assert.match((resolveMilestone({ kind: "title", title: "0.3" }, dup) as { error: string }).error, /several open milestones are named "0.3": #11, #13/);
});

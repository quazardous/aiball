/**
 * #2180 — `aiball ticket approve-children` decides as a pure verdict, so every
 * branch is visible to a test (`die` exits the process). The guarantee under
 * test: approving is a second gesture that names its ids, never "approve
 * whatever is pending now".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planChildrenSweep } from "./ticket.js";

test("no pending children and no ids: nothing to do", () => {
    assert.deepEqual(planChildrenSweep({ parentId: 7, pendingIds: [] }), { kind: "none" });
});

test("without --ids it only lists, and prints the exact command naming the listed ids", () => {
    const v = planChildrenSweep({ parentId: 7, pendingIds: [12, 34] });
    assert.equal(v.kind, "preview");
    assert.equal(v.kind === "preview" ? v.command : null, "aiball --human ticket approve-children --id 7 --ids 12,34");
});

test("--ids approves exactly those ids, deduplicated, whatever else is pending", () => {
    assert.deepEqual(
        planChildrenSweep({ parentId: 7, pendingIds: [12, 34, 56], ids: "12,#34,12" }),
        { kind: "go", ids: [12, 34] },
    );
});

test("malformed --ids is refused, never read as approve-all", () => {
    for (const ids of ["", " , ", "12,abc", "0", "-3"]) {
        assert.equal(planChildrenSweep({ parentId: 7, pendingIds: [12], ids }).kind, "bad-ids", `ids=${JSON.stringify(ids)}`);
    }
});

// #2613 — the megaphone edits the filtered project, or the open ticket's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { megaphoneProject } from "./megaphoneProject";

test("the project filter wins over the open ticket", () => {
    assert.equal(megaphoneProject("p1", 7, "p2"), "p1");
});

test("with no filter, an open ticket names its project", () => {
    assert.equal(megaphoneProject(null, 7, "p2"), "p2");
    assert.equal(megaphoneProject(null, 7, null), null, "the ticket has not loaded yet");
});

test("with no filter and no open ticket, there is no project — even if one was seen before", () => {
    assert.equal(megaphoneProject(null, null, "p2"), null);
});

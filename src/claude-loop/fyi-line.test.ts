/** #3480 — what informs an agent without waking it rides in its next wake, as one line. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFyiLine } from "./fyi-line.js";

test("nothing to say: no line", () => {
    assert.equal(renderFyiLine([]), "");
});

test("grouped by ticket, the latest first, with its project and what happened", () => {
    const line = renderFyiLine([
        { id: 10, kind: "ticket_created", project: "tvty" },
        { id: 11, kind: "comment_added", ticket_id: 10, project: "tvty" },
        { id: 12, kind: "comment_added", ticket_id: 10, project: "tvty" },
        { id: 13, kind: "ticket_closed", ticket_id: 20, project: "tvty" },
        { id: 14, kind: "comment_added", ticket_id: 30, project: "aiball" },
    ]);
    assert.equal(line, "FYI, no action asked: [aiball] #30 reply · [tvty] #20 closed · [tvty] #10 new, ×2.");
});

test("past eight tickets, the rest is counted", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: 100 + i, kind: "comment_added", ticket_id: i + 1, project: "p" }));
    assert.match(renderFyiLine(many), / · \+3 more\.$/);
});

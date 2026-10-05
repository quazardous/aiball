/** #3555 — a comment quoted in a wake says when it was cut, and where to read it whole. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdown, wakeExcerpt } from "./markdown-strip.js";

test("a cut body ends with the truncated marker naming its ticket; a whole one has none", () => {
    const long = "word ".repeat(100);
    assert.match(wakeExcerpt(long, 3555), /…\s\[truncated — read it in aiball: ticket_get #3555\]$/);
    assert.equal(wakeExcerpt("short and whole", 3555), "short and whole");
    assert.equal(wakeExcerpt("ends like this…", 3555), "ends like this…", "an ellipsis the author wrote is not a cut");
    assert.equal(wakeExcerpt(long, null), stripMarkdown(long), "no ticket to name: the cut text as before");
});

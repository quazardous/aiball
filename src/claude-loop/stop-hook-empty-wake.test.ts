// The Stop hook keeps the kernel's rule (#825): no event and no backlog ticket, no wake.
// Open tickets that all rest pass the work check and render an empty phrase; the hook
// typed it and pressed Enter (197 times in a day on one loop).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the Stop hook goes idle on a phrase with no content, before anything is typed", () => {
    const hook = readFileSync(new URL("./stop-hook.ts", import.meta.url), "utf8");
    const guard = hook.indexOf("if (!hasContent) {");
    const inject = hook.indexOf("await term.inject(phrase");
    assert.ok(guard > 0, "the guard is there");
    assert.ok(inject > guard, "and it runs before the inject");
});

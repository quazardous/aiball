/** #3514 — the bar's info word as a code and its parameters, for a client that translates it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { infoCodeOf } from "./info-code.js";

test("every word the bar sets has its code; an unknown one is other; none is null", () => {
    assert.equal(infoCodeOf(null), null);
    assert.equal(infoCodeOf(""), null);
    for (const w of ["resuming", "compacting", "wait", "interrupted", "user"]) assert.deepEqual(infoCodeOf(w), { code: w });
    assert.deepEqual(infoCodeOf("picker:session"), { code: "picker", which: "session" });
    assert.deepEqual(infoCodeOf("picker:mode"), { code: "picker", which: "mode" });
    assert.deepEqual(infoCodeOf("err:rate-limit"), { code: "error", kind: "rate_limit" });
    assert.deepEqual(infoCodeOf("err:overloaded"), { code: "error", kind: "overloaded" });
    assert.deepEqual(infoCodeOf("err:api"), { code: "error", kind: "api" });
    assert.deepEqual(infoCodeOf("retry 3"), { code: "retry", attempt: 3 });
    assert.deepEqual(infoCodeOf("something new"), { code: "other" });
});

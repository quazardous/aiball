// #3099 — a burst of live events is one re-read, and a stale read never lands.
import test from "node:test";
import assert from "node:assert/strict";
import { coalesce, latestOnly } from "./coalesce";

test("a burst becomes one call, the first after a quiet spell runs at once", async () => {
    let calls = 0;
    const run = coalesce(() => { calls++; }, 50);
    run(); run(); run();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 1, "three events, one re-read");
    run(); run();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(calls, 1, "within the window: still waiting");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 2, "then one more, for the whole second burst");
});

test("a read answered after a newer one was asked is not the latest", () => {
    const reads = latestOnly();
    const old = reads.begin();
    const fresh = reads.begin();
    assert.equal(reads.isLatest(old), false, "the page of the project just left");
    assert.equal(reads.isLatest(fresh), true);
});

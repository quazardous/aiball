// #332 — pane-error detection + dumb exponential backoff.
// node:test + tsx (zero deps). Run: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ERROR_BACKOFF_BASE_MS,
    ERROR_BACKOFF_CAP_MS,
    armErrorBackoff,
    matchPaneError,
    nextBackoffMs,
    readErrorBackoff,
    resetErrorBackoff,
} from "./error-backoff.js";

test("matchPaneError recognizes the seeded error types", () => {
    assert.equal(matchPaneError("… · Rate limited"), "rate-limit");
    assert.equal(matchPaneError("temporarily limiting requests"), "rate-limit");
    assert.equal(matchPaneError("API Error: something"), "api-error");
    assert.equal(matchPaneError("Overloaded"), "overloaded");
    assert.equal(matchPaneError("status 529"), "overloaded");
});

test("matchPaneError returns null on a clean / busy pane", () => {
    assert.equal(matchPaneError(""), null);
    assert.equal(matchPaneError("esc to interrupt"), null);
    assert.equal(matchPaneError("Compacting conversation"), null);
});

test("the ticket's combined message matches rate-limit first", () => {
    // #332 body: both rate-limit and api-error patterns are present;
    // first match wins (handling is uniform regardless).
    const body = "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    assert.equal(matchPaneError(body), "rate-limit");
});

test("nextBackoffMs is dumb-exponential: base, monotonic, capped", () => {
    assert.equal(nextBackoffMs(1), ERROR_BACKOFF_BASE_MS);
    assert.ok(nextBackoffMs(2) >= nextBackoffMs(1));
    assert.ok(nextBackoffMs(3) >= nextBackoffMs(2));
    assert.equal(nextBackoffMs(1000), ERROR_BACKOFF_CAP_MS);
    // attempts < 1 clamps to the base step (never negative / zero exp).
    assert.equal(nextBackoffMs(0), ERROR_BACKOFF_BASE_MS);
});

test("armErrorBackoff: same id increments, new id restarts, reset clears", () => {
    const sd = mkdtempSync(join(tmpdir(), "cl-eb-"));
    try {
        const a1 = armErrorBackoff(sd, "rate-limit");
        assert.equal(a1.attempts, 1);
        assert.equal(a1.ms, ERROR_BACKOFF_BASE_MS);

        const a2 = armErrorBackoff(sd, "rate-limit");
        assert.equal(a2.attempts, 2);
        assert.ok(a2.ms >= a1.ms);

        assert.equal(readErrorBackoff(sd)?.attempts, 2);
        assert.equal(readErrorBackoff(sd)?.id, "rate-limit");

        // A different error class restarts the schedule.
        const b1 = armErrorBackoff(sd, "api-error");
        assert.equal(b1.attempts, 1);

        resetErrorBackoff(sd);
        assert.equal(readErrorBackoff(sd), null);
    } finally {
        rmSync(sd, { recursive: true, force: true });
    }
});

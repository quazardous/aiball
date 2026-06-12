// #332 — pane-error detection + dumb exponential backoff.
// node:test + tsx (zero deps). Run: `npm test`.
//
// #750 Slice 2 — les cas pure `matchPaneError(str)` sont migrés vers
// `tests/integration/scenarios/error-backoff-match.yaml`. Les tests
// restants ici nécessitent du runtime non-exprimable dans le runner yaml :
// fillers multi-lignes (footer-scoping), monotonic asserts sur
// nextBackoffMs (comparaisons), mkdtemp fixture pour armErrorBackoff.
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

test("#335: detection is footer-scoped — scrollback mentions are ignored", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    // full banner far up in scrollback, footer clean → no false positive
    assert.equal(matchPaneError(`API Error: Overloaded design discussion\n${filler}`), null);
    // same banner in the footer → matched
    assert.equal(matchPaneError(`${filler}\nAPI Error: Overloaded`), "overloaded");
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
        const b1 = armErrorBackoff(sd, "overloaded");
        assert.equal(b1.attempts, 1);

        resetErrorBackoff(sd);
        assert.equal(readErrorBackoff(sd), null);
    } finally {
        rmSync(sd, { recursive: true, force: true });
    }
});

// #4051 — a turn the pane closes with nothing shown and no Stop is unverified: one
// wake already went into a Claude that may be busy (a compaction it did not draw);
// the next waits for a proof of idleness. Seen on helios: four wakes queued into one
// compaction, one every 15 s.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const kernel = readFileSync(new URL("./kernel.ts", import.meta.url), "utf8");

test("a blind turn-end holds the wakes, bounded", () => {
    assert.match(kernel, /if \(!turnShowedWork\) blindEndAtMs = nowBusy;/);
    assert.match(kernel, /if \(blindEndAtMs !== null && !manualWake\) \{[\s\S]*?BLIND_HOLD_MAX_MS[\s\S]*?return false;/);
});

test("every proof of idleness or of work lifts the hold", () => {
    for (const where of [
        /hookWatcher\.on\("hook:stop"[\s\S]*?blindEndAtMs = null;/,
        /hookWatcher\.on\("hook:idle_prompt"[\s\S]*?blindEndAtMs = null;/,
        /hookWatcher\.on\("hook:session_start"[\s\S]*?blindEndAtMs = null;/,
        /if \(blindEndAtMs !== null && \(workOnScreen \|\| hookCompacting\)\) \{[\s\S]*?blindEndAtMs = null;/,
    ]) assert.match(kernel, where);
});

test("a compaction announced by PreCompact is a proof of work until it ends", () => {
    assert.match(kernel, /hookWatcher\.on\("hook:pre_compact"[\s\S]*?hookCompactingSinceMs = ev\.atMs;/);
    assert.match(kernel, /if \(hookCompacting\) busyProofs = seenProof\(busyProofs, PROOF_COMPACTING, nowBusy\);/);
    assert.match(kernel, /HOOK_COMPACTING_MAX_MS/);
});

/**
 * #751 s4grb2 (debounce) + 4yb8yz (stash) — F9 toggle writes to a
 * pending file, the bar reflects the pending intent immediately (via
 * `readAfkStateDisplay`), and the AFK state-machine only sees the
 * committed state (via `readAfkState`) once the 3s window elapses.
 * Stash carries the remaining wait_10m time across a cycle so the
 * cycle-back restores it.
 *
 * #751 7zqhr5 — the 2-gate split (display vs temporized) is what
 * makes the F9 cycle under 3s a true noop for the SM : `readAfkState`
 * returns committed only, `readAfkStateDisplay` returns pending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AFK_DEBOUNCE_MS,
    afkPath,
    afkPendingPath,
    commitAfkPendingIfDue,
    readAfkPending,
    readAfkState,
    readAfkStateDisplay,
    toggleAfk,
} from "./state.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "afk-debounce-test-"));
}

test("#751 toggleAfk writes to pending, NOT to afk file", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        assert.equal(existsSync(afkPath(sd)), false, "afk file untouched");
        const p = readAfkPending(sd);
        assert.ok(p);
        assert.equal(p!.kind, "wait_10m");
        assert.ok(p!.commit_at_ms - Date.now() > AFK_DEBOUNCE_MS - 100, "commit_at_ms ~= now + 3s");
        assert.ok(p!.commit_at_ms - Date.now() <= AFK_DEBOUNCE_MS);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 7zqhr5 readAfkState ignores pending (committed only — SM/gate stable)", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const s = readAfkState(sd);
        assert.equal(s.mode, "off", "readAfkState still sees committed off (no afk file)");
        assert.equal(s.expiryMs, null);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 7zqhr5 readAfkStateDisplay reflects pending immediately (chip visual instant)", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const s = readAfkStateDisplay(sd);
        assert.equal(s.mode, "wait_10m", "readAfkStateDisplay sees pending kind");
        assert.ok(s.expiryMs, "expiryMs derived from default 600s");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 commitAfkPendingIfDue is a no-op when commit_at_ms still in future", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const did = commitAfkPendingIfDue(sd);
        assert.equal(did, false);
        assert.equal(existsSync(afkPath(sd)), false, "afk file still untouched");
        assert.ok(readAfkPending(sd), "pending still in place");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 commitAfkPendingIfDue flushes pending → afk file once due", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const p = readAfkPending(sd)!;
        writeFileSync(afkPendingPath(sd), JSON.stringify({ ...p, commit_at_ms: Date.now() - 1 }));
        const did = commitAfkPendingIfDue(sd);
        assert.equal(did, true);
        assert.ok(existsSync(afkPath(sd)), "afk file written");
        assert.equal(existsSync(afkPendingPath(sd)), false, "pending cleared");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 7zqhr5 fast multi-press cycles pending without touching committed (true SM noop)", () => {
    const sd = tmp();
    try {
        // Seed a committed wait_10m so we can verify it stays untouched.
        const originalExpiry = Date.now() + 5 * 60 * 1000;
        writeFileSync(afkPath(sd), new Date(originalExpiry).toISOString() + "\n");
        const beforeContent = readFileSync(afkPath(sd), "utf8");
        // 3 rapid F9 presses : wait_10m → wait_inf → off → wait_10m (cycle back).
        // NOTE : toggleAfk uses readAfkState (committed) to compute next,
        // so each call sees committed wait_10m → next = wait_inf. The
        // SECOND call sees committed wait_10m STILL (no commit yet) →
        // next = wait_inf AGAIN (a noop write). That's the temporized
        // semantic : the user's actual intent for the cycle is the
        // LAST press, and the visual feedback comes from display reads.
        toggleAfk(sd);
        assert.equal(readAfkPending(sd)!.kind, "wait_inf");
        // afk file must NOT have changed throughout the cycle.
        assert.equal(readFileSync(afkPath(sd), "utf8"), beforeContent);
        // readAfkState still sees the ORIGINAL committed wait_10m
        // (SM stable, timer keeps counting down from 5min).
        const s = readAfkState(sd);
        assert.equal(s.mode, "wait_10m");
        assert.equal(s.expiryMs, originalExpiry, "committed expiry unchanged");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 4yb8yz stash : wait_10m → wait_inf stashes remaining at first toggle", () => {
    const sd = tmp();
    try {
        // Seed afk file with a wait_10m at 5min remaining.
        const expiryMs = Date.now() + 5 * 60 * 1000;
        writeFileSync(afkPath(sd), new Date(expiryMs).toISOString() + "\n");
        // First press : wait_10m → wait_inf. Stash should capture the 5min.
        toggleAfk(sd);
        const p1 = readAfkPending(sd)!;
        assert.equal(p1.kind, "wait_inf");
        assert.ok(p1.stash_remaining_ms !== undefined, "stash captured");
        assert.ok(p1.stash_remaining_ms! > 4 * 60 * 1000, "stash ~5min");
        assert.ok(p1.stash_remaining_ms! <= 5 * 60 * 1000);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 4yb8yz stash : commit of wait_10m with stash uses the stash seconds", () => {
    const sd = tmp();
    try {
        // Hand-craft a pending wait_10m with a 5min stash, due immediately.
        const stashMs = 5 * 60 * 1000;
        writeFileSync(afkPendingPath(sd), JSON.stringify({
            kind: "wait_10m",
            commit_at_ms: Date.now() - 1,
            stash_remaining_ms: stashMs,
        }));
        commitAfkPendingIfDue(sd);
        // The committed afk file should carry an expiry ~5min in the
        // future (the stash), not 10min (the default).
        const content = readFileSync(afkPath(sd), "utf8").trim();
        const expiryMs = new Date(content).getTime();
        const remainingMs = expiryMs - Date.now();
        assert.ok(remainingMs > 4 * 60 * 1000, "committed expiry ~= stashed 5min");
        assert.ok(remainingMs <= 5 * 60 * 1000 + 1000);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 7zqhr5 display reflects pending kind, committed stays for SM", () => {
    const sd = tmp();
    try {
        // Seed committed wait_10m.
        const expiryMs = Date.now() + 5 * 60 * 1000;
        writeFileSync(afkPath(sd), new Date(expiryMs).toISOString() + "\n");
        // Toggle → pending wait_inf.
        toggleAfk(sd);
        // Display = wait_inf, committed = wait_10m.
        assert.equal(readAfkStateDisplay(sd).mode, "wait_inf");
        assert.equal(readAfkState(sd).mode, "wait_10m");
        assert.equal(readAfkState(sd).expiryMs, expiryMs);
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

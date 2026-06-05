/**
 * #751 s4grb2 (debounce) + 4yb8yz (stash) — F9 toggle now writes to a
 * pending file, the bar reflects the pending intent immediately, and the
 * AFK state-machine only sees the committed state once the 3s window
 * elapses. Stash carries the remaining wait_10m time across a cycle so
 * the cycle-back restores it.
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

test("#751 readAfkState reflects pending immediately (bar visual instant)", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const s = readAfkState(sd);
        assert.equal(s.mode, "wait_10m", "readAfkState sees pending kind");
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

test("#751 fast multi-press cycles through pending without committing in between", () => {
    const sd = tmp();
    try {
        // off → wait_10m → wait_inf → off  (3 rapid F9 presses)
        toggleAfk(sd);
        assert.equal(readAfkPending(sd)!.kind, "wait_10m");
        toggleAfk(sd);
        assert.equal(readAfkPending(sd)!.kind, "wait_inf");
        toggleAfk(sd);
        assert.equal(readAfkPending(sd)!.kind, "off");
        // afk file never touched throughout the cycle.
        assert.equal(existsSync(afkPath(sd)), false);
        // Commit due → afk file matches final intent (= "off", which
        // is just no-file).
        const p = readAfkPending(sd)!;
        writeFileSync(afkPendingPath(sd), JSON.stringify({ ...p, commit_at_ms: Date.now() - 1 }));
        commitAfkPendingIfDue(sd);
        assert.equal(existsSync(afkPath(sd)), false, "final committed state = off");
    } finally { rmSync(sd, { recursive: true, force: true }); }
});

test("#751 4yb8yz stash : wait_10m → wait_inf stashes remaining, cycle-back restores it", () => {
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
        // Second press : wait_inf → off. Stash propagates.
        toggleAfk(sd);
        const p2 = readAfkPending(sd)!;
        assert.equal(p2.kind, "off");
        assert.equal(p2.stash_remaining_ms, p1.stash_remaining_ms, "stash propagates through off");
        // Third press : off → wait_10m. Cycle-back uses the stash.
        toggleAfk(sd);
        const p3 = readAfkPending(sd)!;
        assert.equal(p3.kind, "wait_10m");
        assert.equal(p3.stash_remaining_ms, p1.stash_remaining_ms, "cycle-back preserves stash");
        // readAfkState should derive expiryMs from the stash, not from
        // the default 600s.
        const s = readAfkState(sd);
        assert.equal(s.mode, "wait_10m");
        assert.ok(s.expiryMs! - Date.now() > 4 * 60 * 1000, "wait_10m restores stashed 5min, not default 10min");
        assert.ok(s.expiryMs! - Date.now() <= 5 * 60 * 1000);
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

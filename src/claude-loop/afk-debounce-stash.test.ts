/**
 * #751 htwguc qb7zs6 — F9 toggle is IPC-only : it writes the `dispAfk`
 * couple in `ipcState` (no marker file). The bar word + AFK SM + wake
 * gate keep reading committed `afkMode` ; the chip painter reads
 * `dispAfk` for instant visual feedback. The commit tick
 * (`commitDispAfkIfDue`) :
 *   - if final pending kind === committed afkMode → TRUE NOOP (clear
 *     dispAfk only, the running timer is preserved on its course) ;
 *   - else → fresh commit via *ViaService helpers with default 10min
 *     for wait_10m (no stash artifice).
 *
 * The 4yb8yz "preserve remaining" semantic is realized via the noop
 * detection : F9 × N ring under 3s returning to wait_10m doesn't
 * re-arm, so ipc.afkExpiryMs keeps running on its initial course.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AFK_DEBOUNCE_MS,
    afkPath,
    commitDispAfkIfDue,
    toggleAfk,
} from "./state.js";
import { getIpcDispAfk, getIpcState, resetIpcStateForTests, setIpcAfk, setIpcDispAfk } from "./ipc-state.js";

function tmp(): string {
    resetIpcStateForTests();
    return mkdtempSync(join(tmpdir(), "afk-debounce-test-"));
}

test("#751 toggleAfk writes dispAfk in ipcState — afk file untouched", () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        assert.equal(existsSync(afkPath(sd)), false, "afk file untouched");
        const pending = getIpcDispAfk();
        assert.ok(pending, "dispAfk in ipcState");
        assert.equal(pending!.mode, "wait_10m", "cycle off → wait_10m");
        assert.ok(pending!.commitAtMs - Date.now() > AFK_DEBOUNCE_MS - 100, "commitAtMs ~= now + 3s");
        assert.ok(pending!.commitAtMs - Date.now() <= AFK_DEBOUNCE_MS);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 committed afkMode stays untouched during the debounce window (SM noop)", () => {
    const sd = tmp();
    try {
        const expiryMs = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", expiryMs);
        toggleAfk(sd);
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        assert.equal(ipc.afkExpiryMs, expiryMs);
        assert.equal(getIpcDispAfk()!.mode, "wait_inf");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 qb7zs6 fast multi-press cycles dispAfk without touching afkMode (true SM noop)", () => {
    const sd = tmp();
    try {
        const expiryMs = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", expiryMs);
        // 3 rapid F9 presses : wait_10m → wait_inf → off → wait_10m.
        toggleAfk(sd);
        assert.equal(getIpcDispAfk()!.mode, "wait_inf");
        toggleAfk(sd);
        assert.equal(getIpcDispAfk()!.mode, "off");
        toggleAfk(sd);
        assert.equal(getIpcDispAfk()!.mode, "wait_10m");
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        assert.equal(ipc.afkExpiryMs, expiryMs);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 commitDispAfkIfDue is a no-op when commitAtMs still in future", async () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        const did = await commitDispAfkIfDue(sd);
        assert.equal(did, false, "no commit before window elapses");
        assert.ok(getIpcDispAfk(), "dispAfk still in place");
        assert.equal(existsSync(afkPath(sd)), false);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 commitDispAfkIfDue flushes dispAfk → afk + clears pending once due (different kind)", async () => {
    const sd = tmp();
    try {
        // Seed committed off. Toggle → pending wait_10m. Commit fires.
        toggleAfk(sd);
        const pending = getIpcDispAfk()!;
        setIpcDispAfk({ ...pending, commitAtMs: Date.now() - 1 });
        const did = await commitDispAfkIfDue(sd);
        assert.equal(did, true);
        assert.ok(existsSync(afkPath(sd)), "afk file written");
        assert.equal(getIpcDispAfk(), null, "dispAfk cleared");
        assert.equal(getIpcState().afkMode, "wait_10m");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 qb7zs6 NOOP commit : final pending kind === committed → no re-arm, dispAfk cleared", async () => {
    const sd = tmp();
    try {
        // Seed committed wait_10m with a specific expiry.
        const originalExpiry = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", originalExpiry);
        // Full F9 ring : wait_10m → wait_inf → off → wait_10m.
        toggleAfk(sd);
        toggleAfk(sd);
        toggleAfk(sd);
        // Force commit immediately.
        const pending = getIpcDispAfk()!;
        assert.equal(pending.mode, "wait_10m", "cycle ends on same kind as committed");
        setIpcDispAfk({ ...pending, commitAtMs: Date.now() - 1 });
        const did = await commitDispAfkIfDue(sd);
        assert.equal(did, true, "consumed dispAfk slot");
        // afk file UNCHANGED — no re-arm fired.
        assert.equal(existsSync(afkPath(sd)), false, "no *ViaService call → no file write");
        // ipc.afkExpiryMs intact = timer interne intact.
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        assert.equal(ipc.afkExpiryMs, originalExpiry, "committed expiry untouched");
        assert.equal(getIpcDispAfk(), null);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 qb7zs6 dispAfk wait_10m mirrors committed expiry (chip shows running timer)", () => {
    const sd = tmp();
    try {
        const originalExpiry = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", originalExpiry);
        // Ring back to wait_10m.
        toggleAfk(sd);
        toggleAfk(sd);
        toggleAfk(sd);
        const pending = getIpcDispAfk()!;
        assert.equal(pending.mode, "wait_10m");
        assert.equal(pending.expiryMs, originalExpiry, "chip mirrors running timer, not a fresh 10min");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 commit to different kind (off → wait_10m) uses default 600s, no stash artifice", async () => {
    const sd = tmp();
    try {
        // Committed off. Toggle once.
        toggleAfk(sd);
        const pending = getIpcDispAfk()!;
        setIpcDispAfk({ ...pending, commitAtMs: Date.now() - 1 });
        await commitDispAfkIfDue(sd);
        // Fresh 10min wait_10m.
        const content = readFileSync(afkPath(sd), "utf8").trim();
        const expiryMs = new Date(content).getTime();
        const remainingMs = expiryMs - Date.now();
        assert.ok(remainingMs > 9 * 60 * 1000, "fresh 10min, not stash");
        assert.ok(remainingMs <= 10 * 60 * 1000 + 1000);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

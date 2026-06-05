/**
 * #751 htwguc — F9 toggle is IPC-only : it writes the `dispAfk` couple
 * in `ipcState` (no marker file). The bar word + AFK SM + wake gate
 * keep reading committed `afkMode` ; the chip painter reads `dispAfk`
 * for instant visual feedback. The commit tick (`commitDispAfkIfDue`)
 * flushes `dispAfk` → committed via the *ViaService helpers after
 * AFK_DEBOUNCE_MS, then clears `dispAfk` → convergence.
 *
 * 4yb8yz : stash captures wait_10m remaining when the cycle leaves
 * wait_10m so the cycle-back to wait_10m restores it instead of
 * resetting to 600s.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
        // Seed committed wait_10m via in-memory ipc.
        const expiryMs = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", expiryMs);
        toggleAfk(sd);
        // ipc.afkMode (= committed) untouched.
        const ipc = getIpcState();
        assert.equal(ipc.afkMode, "wait_10m");
        assert.equal(ipc.afkExpiryMs, expiryMs);
        // dispAfk reflects the user's pending choice.
        assert.equal(getIpcDispAfk()!.mode, "wait_inf");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 fast multi-press cycles dispAfk without touching afkMode (true SM noop)", () => {
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
        // ipc.afkMode (= committed) STILL the original wait_10m.
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

test("#751 commitDispAfkIfDue flushes dispAfk → afk + clears pending once due", async () => {
    const sd = tmp();
    try {
        toggleAfk(sd);
        // Backdate commitAtMs so the commit fires immediately.
        const pending = getIpcDispAfk()!;
        setIpcDispAfk({ ...pending, commitAtMs: Date.now() - 1 });
        const did = await commitDispAfkIfDue(sd);
        assert.equal(did, true, "commit fired");
        // afk file written via armAfkViaService.
        assert.ok(existsSync(afkPath(sd)), "afk file written");
        // dispAfk cleared.
        assert.equal(getIpcDispAfk(), null, "dispAfk cleared after convergence");
        // ipc.afkMode also updated by the helper.
        assert.equal(getIpcState().afkMode, "wait_10m");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 4yb8yz stash : wait_10m → wait_inf captures remaining; cycle-back restores it", async () => {
    const sd = tmp();
    try {
        const expiryMs = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", expiryMs);
        // First press : wait_10m → wait_inf. Stash captured.
        toggleAfk(sd);
        const p1 = getIpcDispAfk()!;
        assert.equal(p1.mode, "wait_inf");
        assert.ok(p1.stashMs !== null && p1.stashMs > 4 * 60 * 1000, "stash ~5min");
        // Propagate through off.
        toggleAfk(sd);
        const p2 = getIpcDispAfk()!;
        assert.equal(p2.mode, "off");
        assert.equal(p2.stashMs, p1.stashMs);
        // Cycle-back to wait_10m → uses stash.
        toggleAfk(sd);
        const p3 = getIpcDispAfk()!;
        assert.equal(p3.mode, "wait_10m");
        assert.equal(p3.stashMs, p1.stashMs);
        assert.ok(p3.expiryMs !== null && p3.expiryMs - Date.now() > 4 * 60 * 1000, "wait_10m expiry restores stash, not default 600s");
        assert.ok(p3.expiryMs! - Date.now() <= 5 * 60 * 1000);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 4yb8yz commit of wait_10m with stash uses the stash seconds", async () => {
    const sd = tmp();
    try {
        const stashMs = 5 * 60 * 1000;
        setIpcDispAfk({
            mode: "wait_10m",
            expiryMs: Date.now() + stashMs,
            commitAtMs: Date.now() - 1,
            stashMs,
        });
        await commitDispAfkIfDue(sd);
        // afk file expiry should be ~5min, not 10min default.
        const content = readFileSync(afkPath(sd), "utf8").trim();
        const remainingMs = new Date(content).getTime() - Date.now();
        assert.ok(remainingMs > 4 * 60 * 1000, "committed expiry uses stash ~5min");
        assert.ok(remainingMs <= 5 * 60 * 1000 + 1000);
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

test("#751 cycle-back full ring under 3s commits to the FINAL kind, original state preserved", async () => {
    const sd = tmp();
    try {
        const expiryMs = Date.now() + 5 * 60 * 1000;
        setIpcAfk("wait_10m", expiryMs);
        // Full ring : wait_10m → wait_inf → off → wait_10m.
        toggleAfk(sd);
        toggleAfk(sd);
        toggleAfk(sd);
        // Commit fires.
        const pending = getIpcDispAfk()!;
        setIpcDispAfk({ ...pending, commitAtMs: Date.now() - 1 });
        await commitDispAfkIfDue(sd);
        // afk file = wait_10m with stashed 5min.
        assert.equal(getIpcState().afkMode, "wait_10m");
        const ipc = getIpcState();
        assert.ok(ipc.afkExpiryMs !== null && ipc.afkExpiryMs - Date.now() > 4 * 60 * 1000, "stash applied at commit time");
    } finally { rmSync(sd, { recursive: true, force: true }); resetIpcStateForTests(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStartLock, startLockPath } from "./start-lock.js";

function tmpRoot(): string {
    return mkdtempSync(join(tmpdir(), "cl-startlock-"));
}

// #403: distinct (cwd, agent) → distinct lock paths (no false collision).
test("#403 startLockPath: keyed on (cwd, agent)", () => {
    const root = "/state";
    assert.notEqual(startLockPath(root, "/a", "x"), startLockPath(root, "/b", "x"));
    assert.notEqual(startLockPath(root, "/a", "x"), startLockPath(root, "/a", "y"));
    assert.equal(startLockPath(root, "/a", "x"), startLockPath(root, "/a", "x")); // stable
});

test("#403 acquireStartLock: first wins, concurrent (live holder) loses", () => {
    const root = tmpRoot();
    try {
        const rel = acquireStartLock(root, "/proj", "agent", { pidAlive: () => true });
        assert.ok(rel, "first acquire should succeed");
        assert.ok(existsSync(startLockPath(root, "/proj", "agent")), "lock file created");
        // Second concurrent start sees a LIVE holder → conflict (null).
        const rel2 = acquireStartLock(root, "/proj", "agent", { pidAlive: () => true });
        assert.equal(rel2, null, "second acquire with a live holder must conflict");
        rel!();
        assert.ok(!existsSync(startLockPath(root, "/proj", "agent")), "release removes the lock");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("#403 acquireStartLock: stale lock (dead holder) is reclaimed", () => {
    const root = tmpRoot();
    try {
        const path = startLockPath(root, "/proj", "agent");
        writeFileSync(path, JSON.stringify({ pid: 999999, cwd: "/proj", agent: "agent" }));
        // Holder pid reported dead → reclaim + acquire.
        const rel = acquireStartLock(root, "/proj", "agent", { pidAlive: () => false });
        assert.ok(rel, "a dead holder must be reclaimed");
        assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid, "lock now owned by us");
        rel!();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("#403 acquireStartLock: corrupt lock body treated as stale → reclaimed", () => {
    const root = tmpRoot();
    try {
        const path = startLockPath(root, "/proj", "agent");
        writeFileSync(path, "not json");
        const rel = acquireStartLock(root, "/proj", "agent", { pidAlive: () => true });
        assert.ok(rel, "an unparseable lock is reclaimable");
        rel!();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("#403 acquireStartLock: release then re-acquire succeeds", () => {
    const root = tmpRoot();
    try {
        const rel = acquireStartLock(root, "/proj", "agent", { pidAlive: () => true });
        rel!();
        const rel2 = acquireStartLock(root, "/proj", "agent", { pidAlive: () => true });
        assert.ok(rel2, "re-acquire after release should succeed");
        rel2!();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

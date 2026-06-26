// #859 plan B unit tests — early parent-liveness probe.
// Run: `npx tsx --test src/claude-loop/parent-liveness.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { probeParentTmuxAtBoot, installParentTmuxWatchdog, sweepSiblingTimers, type SpawnSyncFn } from "./parent-liveness.js";

function mockSpawn(out: Partial<SpawnSyncReturns<Buffer>>): SpawnSyncFn {
    return ((() => ({
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        ...out,
    })) as unknown) as SpawnSyncFn;
}

test("alive session (status 0) → probe returns false (no exit)", () => {
    const spawn = mockSpawn({ status: 0 });
    assert.equal(probeParentTmuxAtBoot("tmux", "cl-test", spawn), false);
});

test("dead session (status 1, no spawn error) → probe returns true (caller exits)", () => {
    const spawn = mockSpawn({ status: 1 });
    assert.equal(probeParentTmuxAtBoot("tmux", "cl-test", spawn), true);
});

test("spawn error (PATH glitch, binary swap) → assume-alive (returns false)", () => {
    const spawn = mockSpawn({ error: new Error("ENOENT"), status: null });
    assert.equal(probeParentTmuxAtBoot("tmux", "cl-test", spawn), false);
});

test("any non-zero status without spawn error → gone (returns true)", () => {
    // tmux has-session returns 1 for missing, other codes for misuse —
    // both indicate the session can't be confirmed alive, treat as gone.
    const spawn = mockSpawn({ status: 2 });
    assert.equal(probeParentTmuxAtBoot("tmux", "cl-test", spawn), true);
});

test("passes muxCmd + session name to the spawner", () => {
    let captured: { cmd?: string; args?: ReadonlyArray<string> } = {};
    const spawn = (((cmd: string, args: ReadonlyArray<string>) => {
        captured = { cmd, args: [...args] };
        return mockSpawn({ status: 0 })(cmd, args);
    }) as unknown) as SpawnSyncFn;
    probeParentTmuxAtBoot("psmux", "cl-pisynth", spawn);
    assert.equal(captured.cmd, "psmux");
    assert.deepEqual(captured.args, ["has-session", "-t", "cl-pisynth"]);
});

// #866 Slice 1 — runtime watchdog tests.

interface FakeTimer { cb: () => void; ms: number; cleared: boolean }

function fakeSchedulers(): {
    setIntervalFn: typeof setInterval;
    clearIntervalFn: typeof clearInterval;
    timers: FakeTimer[];
} {
    const timers: FakeTimer[] = [];
    const setIntervalFn = ((cb: () => void, ms: number) => {
        const t: FakeTimer = { cb, ms, cleared: false };
        timers.push(t);
        return t as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    const clearIntervalFn = ((handle: unknown) => {
        const t = handle as FakeTimer;
        t.cleared = true;
    }) as unknown as typeof clearInterval;
    return { setIntervalFn, clearIntervalFn, timers };
}

test("watchdog: alive session → onDead PAS appelé sur tick", () => {
    const { setIntervalFn, clearIntervalFn, timers } = fakeSchedulers();
    const spawn = mockSpawn({ status: 0 });
    let deadCalls = 0;
    installParentTmuxWatchdog({
        muxCmd: "tmux",
        sessionName: "cl-test",
        intervalMs: 5000,
        onDead: () => { deadCalls++; },
        spawnFn: spawn,
        setIntervalFn,
        clearIntervalFn,
    });
    timers[0].cb(); // simulate tick
    assert.equal(deadCalls, 0);
});

test("watchdog: dead session → onDead appelé une seule fois (latch)", () => {
    const { setIntervalFn, clearIntervalFn, timers } = fakeSchedulers();
    const spawn = mockSpawn({ status: 1 });
    let deadCalls = 0;
    installParentTmuxWatchdog({
        muxCmd: "tmux",
        sessionName: "cl-test",
        intervalMs: 5000,
        onDead: () => { deadCalls++; },
        spawnFn: spawn,
        setIntervalFn,
        clearIntervalFn,
    });
    timers[0].cb();
    timers[0].cb(); // 2nd tick should be no-op (latched)
    timers[0].cb();
    assert.equal(deadCalls, 1);
});

test("watchdog: spawn error → assume-alive (pas d'onDead)", () => {
    const { setIntervalFn, clearIntervalFn, timers } = fakeSchedulers();
    const spawn = mockSpawn({ error: new Error("ENOENT"), status: null });
    let deadCalls = 0;
    installParentTmuxWatchdog({
        muxCmd: "tmux",
        sessionName: "cl-test",
        intervalMs: 5000,
        onDead: () => { deadCalls++; },
        spawnFn: spawn,
        setIntervalFn,
        clearIntervalFn,
    });
    timers[0].cb();
    assert.equal(deadCalls, 0);
});

test("watchdog.stop(): clearInterval idempotent", () => {
    const { setIntervalFn, clearIntervalFn, timers } = fakeSchedulers();
    const spawn = mockSpawn({ status: 0 });
    const w = installParentTmuxWatchdog({
        muxCmd: "tmux",
        sessionName: "cl-test",
        onDead: () => {},
        spawnFn: spawn,
        setIntervalFn,
        clearIntervalFn,
    });
    w.stop();
    w.stop(); // 2nd stop should not throw
    assert.equal(timers[0].cleared, true);
});

// #866 Slice 4 — sibling timer sweep tests.

test("sweepSiblingTimers: process avec CL_STATE_DIR matching → killed", () => {
    if (process.platform !== "linux") return; // no-op on other platforms
    const sd = "/home/david/.claude-loop/cl-test-fake";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        99999, // self pid
        () => ["1234", "5678"],
        (pid) => pid === 1234 ? `PATH=/bin\0CL_STATE_DIR=${sd}\0HOME=/h\0` : `PATH=/bin\0CL_STATE_DIR=/other\0`,
        (pid) => { killed.push(pid); },
        () => "node /r/node_modules/.bin/tsx /r/src/claude-loop/kernel.ts", // #1059 kernel cmdline
    );
    assert.deepEqual(killed, [1234]);
});

test("sweepSiblingTimers: self pid exclu", () => {
    if (process.platform !== "linux") return;
    const sd = "/sd";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        42,
        () => ["42"],
        () => `\0CL_STATE_DIR=${sd}\0`,
        (pid) => { killed.push(pid); },
    );
    assert.deepEqual(killed, []);
});

test("sweepSiblingTimers: env non-readable (process disparu race) → skip", () => {
    if (process.platform !== "linux") return;
    const sd = "/sd";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        99999,
        () => ["1234"],
        () => null,
        (pid) => { killed.push(pid); },
    );
    assert.deepEqual(killed, []);
});

test("sweepSiblingTimers: match au début du env buffer (sans \\0 leading)", () => {
    if (process.platform !== "linux") return;
    const sd = "/sd";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        99999,
        () => ["1234"],
        () => `CL_STATE_DIR=${sd}\0PATH=/bin\0`, // marker AT START
        (pid) => { killed.push(pid); },
        () => "tsx /r/src/claude-loop/kernel.ts", // #1059 kernel cmdline
    );
    assert.deepEqual(killed, [1234]);
});

test("sweepSiblingTimers: #1059 — CL_STATE_DIR match but NON-kernel cmdline (proxy) is SPARED", () => {
    if (process.platform !== "linux") return;
    const sd = "/sd";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        99999,
        () => ["1234"],
        () => `CL_STATE_DIR=${sd}\0PATH=/bin\0`,
        (pid) => { killed.push(pid); },
        () => "python3 -B /r/src/claude-loop/pty-proxy.py -- claude", // proxy → must NOT be killed
    );
    assert.deepEqual(killed, []);
});

test("sweepSiblingTimers: substring match évité (CL_STATE_DIR_BACKUP → no kill)", () => {
    if (process.platform !== "linux") return;
    const sd = "/sd";
    const killed: number[] = [];
    sweepSiblingTimers(
        sd,
        99999,
        () => ["1234"],
        () => `\0CL_STATE_DIR_BACKUP=${sd}\0`, // similar key, NOT the one we look for
        (pid) => { killed.push(pid); },
    );
    assert.deepEqual(killed, []);
});

test("watchdog: default intervalMs = 5000", () => {
    const { setIntervalFn, clearIntervalFn, timers } = fakeSchedulers();
    installParentTmuxWatchdog({
        muxCmd: "tmux",
        sessionName: "cl-test",
        onDead: () => {},
        spawnFn: mockSpawn({ status: 0 }),
        setIntervalFn,
        clearIntervalFn,
    });
    assert.equal(timers[0].ms, 5000);
});

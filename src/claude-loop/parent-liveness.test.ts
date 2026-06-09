// #859 plan B unit tests — early parent-liveness probe.
// Run: `npx tsx --test src/claude-loop/parent-liveness.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import { probeParentTmuxAtBoot, type SpawnSyncFn } from "./parent-liveness.js";

function mockSpawn(out: Partial<SpawnSyncReturns<Buffer>>): SpawnSyncFn {
    return (() => ({
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: 0,
        signal: null,
        ...out,
    })) as SpawnSyncFn;
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
    const spawn = ((cmd: string, args: ReadonlyArray<string>) => {
        captured = { cmd, args: [...args] };
        return mockSpawn({ status: 0 })(cmd, args);
    }) as SpawnSyncFn;
    probeParentTmuxAtBoot("psmux", "cl-pisynth", spawn);
    assert.equal(captured.cmd, "psmux");
    assert.deepEqual(captured.args, ["has-session", "-t", "cl-pisynth"]);
});

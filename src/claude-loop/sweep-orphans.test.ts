/**
 * #1601 — sweeping orphan kernels off Linux.
 *
 * The bug they pin: `sweepOrphans` returned at once when the platform was not
 * Linux, so nothing collected an orphan kernel on Windows. A `reload` kills
 * only the pid written in `loop.pid`; the ones earlier reloads left behind
 * piled up. Seen for real: three kernels for one loop, all alive, all
 * painting the bar.
 *
 * These tests kill REAL processes rather than faking `process.kill`: the
 * failure was that nothing died, so a test that does not check the death
 * checks nothing.
 */
import { test } from "node:test";
import { sleep } from "../tests/lib.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphans } from "./cmds/manage.js";
import { registerKernelPid, readKernelPids, kernelPidsPath, claimLoopAsKernel } from "./state.js";

const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * A throwaway process that lives until it is killed. Recorded in `victims` so
 * `withSd` collects it WHATEVER HAPPENS: otherwise a failing assertion left an
 * orphan `setInterval` that kept the runner alive — the test hung instead of
 * failing, the worse of the two.
 */
let victims: { pid: number; kill: () => void }[] = [];

function spawnVictim(): { pid: number; kill: () => void } {
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const v = { pid: c.pid as number, kill: () => { try { c.kill("SIGKILL"); } catch { /* already dead */ } } };
    victims.push(v);
    return v;
}

function withSd<T>(fn: (sd: string) => Promise<T>): Promise<T> {
    const sd = mkdtempSync(join(tmpdir(), "sweep-"));
    victims = [];
    return fn(sd).finally(() => {
        for (const v of victims) v.kill();
        victims = [];
        try { rmSync(sd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

// A guard for the `sweepOrphans` cases only: on Linux it reads `/proc` and
// ignores the registry, so these cases have nothing to check there. Do NOT
// extend it to the rest of the file by proximity — see the `claimLoopAsKernel`
// section below, which runs on every platform and must be tested on all.
const tt = process.platform === "linux" ? test.skip : test;

tt("a registered kernel still alive is killed", async () => {
    await withSd(async (sd) => {
        const victim = spawnVictim();
        registerKernelPid(sd, victim.pid);
        await sleep(150);
        assert.equal(isAlive(victim.pid), true, "control: the victim runs before the sweep");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [victim.pid]);
        assert.equal(isAlive(victim.pid), false, "the orphan must be DEAD, not just listed");
    });
});

tt("the sweeper does not kill itself", async () => {
    await withSd(async (sd) => {
        registerKernelPid(sd, process.pid);
        const { killed } = sweepOrphans(sd);
        assert.deepEqual(killed, [], "process.pid is the survivor, never a target");
        assert.deepEqual(readKernelPids(sd), [process.pid], "and it stays registered");
    });
});

tt("a pid already dead leaves the registry without being counted", async () => {
    await withSd(async (sd) => {
        const gone = spawnVictim();
        gone.kill();
        await sleep(200);
        registerKernelPid(sd, gone.pid);

        const { killed } = sweepOrphans(sd);
        assert.deepEqual(killed, [], "nothing to kill");
        assert.deepEqual(readKernelPids(sd), [], "the registry is purged of the dead");
    });
});

tt("several orphans are all collected", async () => {
    // The real case: three kernels for one loop, two to collect.
    await withSd(async (sd) => {
        const a = spawnVictim(), b = spawnVictim();
        registerKernelPid(sd, a.pid);
        registerKernelPid(sd, b.pid);
        registerKernelPid(sd, process.pid);
        await sleep(150);

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.equal(killed.length, 2, `expected 2 killed, got ${JSON.stringify(killed)}`);
        assert.equal(isAlive(a.pid), false);
        assert.equal(isAlive(b.pid), false);
        assert.deepEqual(readKernelPids(sd), [process.pid], "only the survivor stays registered");
    });
});

tt("a missing registry does not fail the sweep", async () => {
    await withSd(async (sd) => {
        assert.equal(existsSync(kernelPidsPath(sd)), false);
        assert.deepEqual(sweepOrphans(sd).killed, []);
    });
});

// --- claimLoopAsKernel: the sweep AT BOOT ----------------------------------
// The sweep the CLI drives runs before it spawns, so it cannot see a kernel
// that appears afterwards — and one commonly does: editing the source makes
// the current kernel reload itself, and a `claude-loop reload` run at the
// same moment adds a second. Measured after exactly that sequence: two live
// kernels per loop, both registered, none swept. Doing it at boot heals it.
//
// THESE CASES RUN EVERYWHERE, `test` and not `tt`. The Linux guard above is
// for `sweepOrphans`, which reads `/proc` there and ignores the registry. It
// does not hold for `claimLoopAsKernel`, called unconditionally at kernel
// boot (`kernel.ts`), so on Linux too. First filed under the same guard for
// convenience, they never ran: a function sending SIGKILLs ran on the main
// platform with zero tests running there, and the Linux lane was green
// because it tested none of it. Nothing here depends on the platform — real
// processes are spawned and checked dead, which holds on both sides.

test("claimLoopAsKernel kills the older kernels and keeps the new one", async () => {
    await withSd(async (sd) => {
        const older = spawnVictim();
        registerKernelPid(sd, older.pid);
        await sleep(150);

        const { killed } = claimLoopAsKernel(sd);
        await sleep(300);

        assert.deepEqual(killed, [older.pid], "the older one must be killed");
        assert.equal(isAlive(older.pid), false);
        assert.deepEqual(readKernelPids(sd), [process.pid], "the new one alone stays registered");
    });
});

test("claimLoopAsKernel registers even when there is no one to kill", async () => {
    await withSd(async (sd) => {
        const { killed } = claimLoopAsKernel(sd);
        assert.deepEqual(killed, []);
        assert.deepEqual(readKernelPids(sd), [process.pid], "a first boot must still register");
    });
});

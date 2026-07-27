/**
 * The kernel roll-call, and the one thing it must never do.
 *
 * `claimLoopAsKernel` SIGKILLs every pid the roll-call hands it. `kill(pid, 0)`
 * only answers "a process with this number exists" — never "it is one of ours"
 * — and `kernels.pids` outlives the processes it names, because nothing
 * rewrites it when the machine goes down. So a reboot leaves a stale pid that
 * the OS has since reassigned, and the next kernel to boot would kill a
 * stranger. The boot stamp is what closes that.
 *
 * The tests that shipped with the roll-call prove the right processes DIE.
 * These prove the wrong ones do not.
 *
 * Run: `npx tsx --test src/claude-loop/kernel-rollcall.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bootEpochSec,
    kernelPidsPath,
    readKernelPids,
    registerKernelPid,
    writeKernelPids,
} from "./state.js";

function withDir(fn: (sd: string) => void): void {
    const sd = mkdtempSync(join(tmpdir(), "rollcall-"));
    try { fn(sd); } finally { rmSync(sd, { recursive: true, force: true }); }
}

test("a pid registered in this boot is returned", () => {
    withDir((sd) => {
        registerKernelPid(sd, 4242);
        assert.deepEqual(readKernelPids(sd), [4242]);
    });
});

test("a pid from ANOTHER boot is never returned — the reboot case", () => {
    // The whole point: after a restart this number belongs to somebody else.
    withDir((sd) => {
        writeFileSync(kernelPidsPath(sd), `4242 ${bootEpochSec() - 86_400}\n`);
        assert.deepEqual(readKernelPids(sd), [], "a stale pid must not be handed to SIGKILL");
    });
});

test("an UNSTAMPED line is never returned — files written before the stamp", () => {
    // It cannot say which boot it came from, so it cannot be vouched for.
    withDir((sd) => {
        writeFileSync(kernelPidsPath(sd), "4242\n7252\n");
        assert.deepEqual(readKernelPids(sd), []);
    });
});

test("a stale entry does not hide a live one written beside it", () => {
    withDir((sd) => {
        writeFileSync(kernelPidsPath(sd), `111 ${bootEpochSec() - 99_999}\n`);
        registerKernelPid(sd, 222);
        assert.deepEqual(readKernelPids(sd), [222]);
    });
});

test("clock drift within a boot does not disown our own pids", () => {
    // `Date.now() - uptime` wobbles by a second or two as the clock is adjusted;
    // an equality test would drop live kernels and let orphans pile up again.
    withDir((sd) => {
        for (const skew of [-5, -1, 0, 1, 5]) {
            writeFileSync(kernelPidsPath(sd), `900 ${bootEpochSec() + skew}\n`);
            assert.deepEqual(readKernelPids(sd), [900], `skew ${skew}s must still count as this boot`);
        }
    });
});

test("rewriting the roll-call re-stamps it, so survivors stay claimable", () => {
    // The sweep writes back the pids it did NOT kill. If they lost their stamp
    // there, the next boot would treat live kernels as foreign and stop reaping.
    withDir((sd) => {
        writeKernelPids(sd, [11, 22]);
        assert.deepEqual(readKernelPids(sd), [11, 22]);
        const written = readFileSync(kernelPidsPath(sd), "utf8").trim().split("\n");
        for (const line of written) {
            assert.match(line, /^\d+ \d+$/, `every line carries a stamp: ${JSON.stringify(line)}`);
        }
    });
});

test("a missing roll-call is empty, not an error", () => {
    withDir((sd) => assert.deepEqual(readKernelPids(sd), []));
});

test("garbage lines are skipped without taking the file down with them", () => {
    withDir((sd) => {
        writeFileSync(kernelPidsPath(sd), `\nnot-a-pid stamp\n-1 ${bootEpochSec()}\n77 ${bootEpochSec()}\n`);
        assert.deepEqual(readKernelPids(sd), [77]);
    });
});

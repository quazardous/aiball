/**
 * The Linux branch of `sweepOrphans` — the one that reads `/proc/<pid>/environ`
 * to ask which state dir a process belongs to, then SIGKILLs.
 *
 * No test executed it, on any platform. The only file touching `sweepOrphans`
 * skips entirely on Linux (its guard is aimed at the roll-call branch, which
 * has nothing to check there), and `/proc` does not exist anywhere else. Code
 * that sends SIGKILL, on the main platform, with no test running against it.
 *
 * `/proc` is read for real here rather than through an injected root. What
 * breaks in this branch is the FILTERING — the exact-key match and the
 * `kernelOnly` guard — and a hand-built tree encodes our own assumptions about
 * the shape of `environ` instead of testing them. So: spawn real processes,
 * record their actual `environ` as a witness, then check who dies and who
 * survives.
 *
 * The witness is not decoration. A survivor that survives because its env was
 * never set looks exactly like a filter that works.
 *
 * Run: `npx tsx --test src/claude-loop/sweep-orphans-proc.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphans } from "./cmds/manage.js";

// `/proc` exists nowhere else — the branch under test is unreachable there.
const tt = process.platform === "linux" ? test : test.skip;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
};

type Victim = { pid: number; environ: string; cmdline: string };

let victims: ChildProcess[] = [];

/**
 * A disposable process carrying `env`, and `kernel.ts` in its command line when
 * asked.
 *
 * The env is built by hand rather than inherited: this session itself runs
 * under a `claude-loop`, so `process.env` holds the LIVE loop's `CL_STATE_DIR`.
 * Passing that down would make throwaway processes reapable by a real sweep.
 *
 * `kernelLike` puts the path in a positional argument — `kernel.ts` only has to
 * appear in the command line, which is all the filter reads, and an argument
 * does that without depending on the node version's type stripping.
 *
 * `first` decides whether the marker is the FIRST entry of `environ`, i.e.
 * whether a NUL precedes it. The two positions take different clauses of the
 * filter (`includes` vs `startsWith`); without both, one half never runs.
 */
async function spawnVictim(
    opts: { env: Record<string, string>; kernelLike?: boolean; first?: boolean; sd: string },
): Promise<Victim> {
    const argv = ["-e", "setInterval(() => {}, 1000)"];
    if (opts.kernelLike) argv.push(join(opts.sd, "kernel.ts"));
    const PATH = process.env.PATH ?? "";
    const c = spawn(process.execPath, argv, {
        stdio: "ignore",
        env: opts.first ? { ...opts.env, PATH } : { PATH, ...opts.env },
    });
    victims.push(c);
    const pid = c.pid as number;

    // `/proc/<pid>/environ` only becomes readable once the exec has happened;
    // wait for the witness rather than guessing a delay.
    let environ = "", cmdline = "";
    for (let i = 0; i < 50 && environ === ""; i++) {
        try {
            environ = readFileSync(`/proc/${pid}/environ`, "utf8");
            cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        } catch { await sleep(20); }
    }
    assert.notEqual(environ, "", `witness unreadable: /proc/${pid}/environ`);
    return { pid, environ, cmdline };
}

function withSd<T>(fn: (sd: string) => Promise<T>): Promise<T> {
    const sd = mkdtempSync(join(tmpdir(), "sweep-proc-"));
    victims = [];
    return fn(sd).finally(() => {
        for (const c of victims) { try { c.kill("SIGKILL"); } catch { /* already dead */ } }
        victims = [];
        try { rmSync(sd, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

tt("a satellite of the state dir is actually killed", async () => {
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${sd}`), "witness: the victim carries the marker");
        assert.equal(isAlive(v.pid), true, "witness: it is running before the sweep");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [v.pid]);
        assert.equal(isAlive(v.pid), false, "the orphan must be DEAD, not merely listed");
    });
});

tt("a key ours is a SUFFIX of does not match", async () => {
    // The trap the leading NUL catches, and the only one on that side:
    // `OLD_CL_STATE_DIR=<sd>` contains `CL_STATE_DIR=<sd>` verbatim, so an
    // unanchored `includes` reads it as ours.
    //
    // Not to be confused with `CL_STATE_DIR_BACKUP=<sd>`, the example the code
    // comment used to give: that one CANNOT false-match, `_BACKUP` sitting
    // before the `=`. A case written on it passes with or without the anchor —
    // measured: it survives the mutation that drops the NUL.
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { OLD_CL_STATE_DIR: sd }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${sd}`), "witness: the decoy does contain our marker as a substring");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [], "no victim: the key is not ours");
        assert.equal(isAlive(v.pid), true, "a look-alike key must SURVIVE");
    });
});

tt("the marker as the FIRST entry of environ is still recognised", async () => {
    // The first variable in `environ` has no NUL before it, so
    // `includes(`\0…`)` misses it — that is what the `startsWith` clause
    // catches. Without this case half the filter never runs, and a real orphan
    // would survive depending on the order of its env.
    await withSd(async (sd) => {
        const v = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, first: true });
        assert.ok(v.environ.startsWith(`CL_STATE_DIR=${sd}\0`), "witness: the marker leads environ");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [v.pid]);
        assert.equal(isAlive(v.pid), false);
    });
});

tt("a neighbouring state dir ours is a prefix of survives", async () => {
    // `/tmp/sweep-proc-ab` and `/tmp/sweep-proc-abcd`: two separate loops.
    // Without the trailing NUL, sweeping the first carries off the second.
    await withSd(async (sd) => {
        const neighbour = `${sd}-neighbour`;
        const v = await spawnVictim({ env: { CL_STATE_DIR: neighbour }, sd });
        assert.ok(v.environ.includes(`CL_STATE_DIR=${neighbour}`), "witness: the neighbour carries its own state dir");

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.deepEqual(killed, [], "sweeping one loop does not spill onto its neighbour");
        assert.equal(isAlive(v.pid), true);
    });
});

tt("kernelOnly spares the proxy and takes only kernels", async () => {
    // On a RELOAD the proxy is alive and carries the same `CL_STATE_DIR`. An
    // unfiltered sweep kills it, and claude's PTY dies with it.
    await withSd(async (sd) => {
        const proxy = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        const kernel = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, kernelLike: true });
        assert.ok(!/kernel\.ts/.test(proxy.cmdline), "witness: the proxy has no kernel.ts in its command line");
        assert.ok(/kernel\.ts/.test(kernel.cmdline), "witness: the kernel does");

        const { killed } = sweepOrphans(sd, { kernelOnly: true });
        await sleep(300);

        assert.deepEqual(killed, [kernel.pid], "only the kernel falls");
        assert.equal(isAlive(kernel.pid), false);
        assert.equal(isAlive(proxy.pid), true, "the proxy must SURVIVE a reload");
    });
});

tt("without kernelOnly the sweep takes the whole state dir", async () => {
    // The `cmdStart` case: cold start, nothing live to protect.
    await withSd(async (sd) => {
        const a = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd });
        const b = await spawnVictim({ env: { CL_STATE_DIR: sd }, sd, kernelLike: true });

        const { killed } = sweepOrphans(sd);
        await sleep(300);

        assert.equal(killed.length, 2, `expected 2 killed, got ${JSON.stringify(killed)}`);
        assert.equal(isAlive(a.pid), false);
        assert.equal(isAlive(b.pid), false);
    });
});

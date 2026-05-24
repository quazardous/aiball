/**
 * #403 — atomic start lock for `claude-loop start`, keyed on (cwd, agent).
 *
 * The old guard (`findLiveLoopForCwdAgent` + spawn) was a check-then-act: two
 * concurrent `claude-loop start` in the same dir+agent could both pass the live
 * check before either registered its tmux session, and both would spawn. This
 * closes that TOCTOU window with an OS-atomic lock.
 *
 * `O_EXCL` create is the atomic primitive — only one concurrent start can create
 * the lock file; the loser sees it. A PRE-EXISTING lock is reclaimed iff its
 * holder pid is dead (a start that crashed mid-spawn left it behind); a LIVE
 * holder means a real concurrent start (or a start still spawning) → conflict.
 * The lock is held for the duration of the start process; once it exits the
 * tmux session is the source of truth and `findLiveLoopForCwdAgent` guards the
 * steady state, so the lock only needs to cover the spawn window.
 *
 * Pure-ish (filesystem + an injectable pid-liveness probe) so it unit-tests
 * without spawning real processes — same shape as decision-gate.ts / landscape.ts.
 *
 * NOTE: the lock files live in the loop state root with a leading dot
 * (`.start-lock-<hash>`); `pruneDeadStateDirs` must skip dotfiles so a concurrent
 * start's prune never deletes a live lock.
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface StartLockDeps {
    /** True iff `pid` is a live process. Injectable so tests don't fork. */
    pidAlive: (pid: number) => boolean;
}

/** Default liveness probe: signal 0 tests existence without killing. EPERM means
 *  the process exists but is owned by someone else (still "alive"). */
export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

const defaultDeps: StartLockDeps = { pidAlive };

/** Lock-file path for a (cwd, agent) pair under the loop state root. The hash
 *  keeps the name fixed-length and filesystem-safe regardless of the cwd. */
export function startLockPath(stateRoot: string, cwd: string, agent: string | undefined): string {
    const key = createHash("sha1").update(`${cwd}\0${agent ?? ""}`).digest("hex").slice(0, 16);
    return join(stateRoot, `.start-lock-${key}`);
}

/**
 * Try to claim the start lock for (cwd, agent). Returns a release function on
 * success, or `null` when a LIVE holder already owns it (real concurrent start
 * / running loop) — the caller must then refuse to spawn. A stale lock (dead
 * holder, or unparseable) is reclaimed transparently and the claim retried once.
 */
export function acquireStartLock(
    stateRoot: string,
    cwd: string,
    agent: string | undefined,
    deps: StartLockDeps = defaultDeps,
): null | (() => void) {
    const path = startLockPath(stateRoot, cwd, agent);
    try { mkdirSync(stateRoot, { recursive: true }); } catch { /* already exists */ }
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // O_CREAT | O_EXCL | O_WRONLY — atomic "create iff absent".
            const fd = openSync(path, "wx");
            writeSync(fd, JSON.stringify({ pid: process.pid, cwd, agent: agent ?? null, ts: new Date().toISOString() }));
            closeSync(fd);
            return () => { try { unlinkSync(path); } catch { /* already released */ } };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
            // A lock exists. Reclaim it only if the holder is dead.
            let holderPid = 0;
            try { holderPid = Number(JSON.parse(readFileSync(path, "utf8")).pid) || 0; } catch { /* corrupt → treat as stale */ }
            if (holderPid && deps.pidAlive(holderPid)) return null; // live holder → conflict
            try { unlinkSync(path); } catch { /* raced away by another reclaimer */ }
            // loop: retry the atomic create once after reclaiming the stale lock
        }
    }
    return null; // lost the reclaim race to another start
}

/**
 * #859 plan B — early parent-liveness probe extracted into a pure
 * function so the boot-time check in `timer.ts` is testable.
 *
 * Returns `true` iff the probe is confident the tmux session is GONE
 * (= caller should exit immediately to avoid an orphan). Returns
 * `false` for both "session alive" and "spawn error" — assume-alive on
 * transient error is intentional: the runtime watchdog re-probes every
 * 5s and will catch it next tick if the session genuinely died.
 *
 * #866 — `installParentTmuxWatchdog` provides the RUNTIME continuation
 * of the boot-time probe (= same pure function, scheduled tick).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type SpawnSyncFn = typeof spawnSync;

export function probeParentTmuxAtBoot(
    muxCmd: string,
    sessionName: string,
    spawnFn: SpawnSyncFn = spawnSync,
): boolean {
    const r: SpawnSyncReturns<Buffer> = spawnFn(muxCmd, ["has-session", "-t", sessionName], { stdio: "ignore" });
    if (r.error) return false; // transient — let the runtime watchdog re-probe
    return r.status !== 0;
}

/** #866 Slice 4 — at-boot sweep des sibling timers bound au même
 *  CL_STATE_DIR. Catches les vieux timers fantômes (pre-#866 sans
 *  watchdog, ou timers échappés à cmdReload+sweepOrphans). Linux-only :
 *  scan /proc/<pid>/environ. Sur autres plateformes, no-op silencieux —
 *  le watchdog runtime + le bash trap couvrent le worst case.
 *
 *  Appelé tôt dans le boot du timer, AVANT le bind loop.sock pour éviter
 *  qu'un fantôme garde le socket. Le nouveau timer (= self) est exclu
 *  par `process.pid` check. */
export function sweepSiblingTimers(
    stateDir: string,
    selfPid: number = process.pid,
    readdirImpl: (path: string) => string[] = (p) => readdirSyncImpl(p),
    readEnvImpl: (pid: number) => string | null = readProcEnvironImpl,
    killImpl: (pid: number) => void = (pid) => { process.kill(pid, "SIGKILL"); },
): number[] {
    if (process.platform !== "linux") return [];
    const killed: number[] = [];
    const marker = `CL_STATE_DIR=${stateDir}`;
    let entries: string[];
    try { entries = readdirImpl("/proc"); }
    catch { return killed; }
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || pid === selfPid) continue;
        const env = readEnvImpl(pid);
        if (env === null) continue;
        if (!env.includes(`\0${marker}\0`) && !env.startsWith(`${marker}\0`)) continue;
        try { killImpl(pid); killed.push(pid); }
        catch { /* race : process already dead */ }
    }
    return killed;
}

// Real-impl indirections so tests can inject. Lazy require pour ne pas
// charger fs au module-load (#913 : un static `import * as fs` cassait
// claude-loop runtime — root cause non encore comprise, mais le lazy
// require restaure le comportement antérieur).
function readdirSyncImpl(path: string): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    return fs.readdirSync(path);
}
function readProcEnvironImpl(pid: number): string | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    } catch { return null; }
}

/** #866 — runtime parent watchdog. Periodically probes the tmux session
 *  via the same pure function used at boot. On dead-session detection,
 *  invokes `onDead()` once (= timer's graceful shutdown). Returns a
 *  `{stop()}` handle for cleanup at exit.
 *
 *  Default interval = 5s : long enough to be cheap (1 spawn / 5s), short
 *  enough that an orphan timer disappears within ~5s of its parent's
 *  death — well below any human-noticeable delay. */
export interface WatchdogHandle {
    stop(): void;
}

export function installParentTmuxWatchdog(opts: {
    muxCmd: string;
    sessionName: string;
    intervalMs?: number;
    onDead: () => void;
    spawnFn?: SpawnSyncFn;
    setIntervalFn?: typeof setInterval;
    clearIntervalFn?: typeof clearInterval;
}): WatchdogHandle {
    const intervalMs = opts.intervalMs ?? 5000;
    const setIntervalImpl = opts.setIntervalFn ?? setInterval;
    const clearIntervalImpl = opts.clearIntervalFn ?? clearInterval;
    let fired = false;
    const tick = (): void => {
        if (fired) return;
        const dead = probeParentTmuxAtBoot(opts.muxCmd, opts.sessionName, opts.spawnFn);
        if (dead) {
            fired = true;
            try { opts.onDead(); } catch { /* swallow */ }
        }
    };
    const handle = setIntervalImpl(tick, intervalMs);
    return {
        stop(): void {
            try { clearIntervalImpl(handle); } catch { /* swallow */ }
        },
    };
}

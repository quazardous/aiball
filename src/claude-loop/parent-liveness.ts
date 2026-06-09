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

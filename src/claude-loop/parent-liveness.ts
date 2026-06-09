/**
 * #859 plan B — early parent-liveness probe extracted into a pure
 * function so the boot-time check in `timer.ts` is testable.
 *
 * Returns `true` iff the probe is confident the tmux session is GONE
 * (= caller should exit immediately to avoid an orphan). Returns
 * `false` for both "session alive" and "spawn error" — assume-alive on
 * transient error is intentional: the runtime watchdog re-probes every
 * 2s and will catch it next tick if the session genuinely died.
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

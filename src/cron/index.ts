/**
 * #1566 — the periodic-task table.
 *
 * **This is the only place to read what the daemon runs on a timer.** Adding a
 * recurring job = adding a row here; `daemon.ts` stays a single
 * `startScheduler(CRON_TASKS)` call. Same shape as the router barrel
 * (`src/api.ts`): concerns live in their own modules, one file wires them.
 *
 * The mechanism — catch, overlap guard, boot run, kill switch, and the
 * last-run / duration / last-error record behind `GET /api/health` — lives in
 * `runner.ts` so no task has to re-implement it. See that file for why the
 * previous hand-wired `setInterval` block didn't extend.
 */
import { captureTokenSnapshotIfDue } from "../db.js";
import { checkSandboxPings } from "../sandbox/watcher.js";
import { revealExpiredPostpones } from "./postpone.js";
import { runUpstreamWatch } from "../upstream-watch-run.js";
import type { CronTask } from "./runner.js";

export { startScheduler, schedulerStatus } from "./runner.js";
export type { CronTask, CronTaskStatus } from "./runner.js";

const MINUTE = 60_000;

export const CRON_TASKS: readonly CronTask[] = [
    {
        // Runs once at boot too, in case the daemon was down past a deadline.
        // 60s is fine grain — users snooze for hours / days, not minutes.
        name: "postpone-reveal",
        everyMs: 60_000,
        run: revealExpiredPostpones,
    },
    {
        // #1200 — token-usage snapshots for the over-time chart. The capture
        // self-throttles, so running it at boot is idempotent.
        name: "token-snapshot",
        everyMs: 60 * MINUTE,
        // Wrapped: it returns a count, and a task's return value is meaningless
        // to the runner. Keeping `run` typed as void-or-promise is what makes
        // the async case explicit in the interface.
        run: () => { captureTokenSnapshotIfDue(); },
    },
    {
        // Re-arms dead loop sandboxes when their agent receives a new ping
        // (#B.81 point 2).
        name: "sandbox-watcher",
        everyMs: 30_000,
        // Was a boot-time `if` around the whole wiring; as a per-tick predicate
        // the outcome is identical (the env can't change mid-process) but the
        // task now shows up in the health table as disabled instead of being
        // invisible.
        enabled: () => process.env.AIBALL_SANDBOX_WATCHER !== "0",
        run: checkSandboxPings,
    },
    {
        // #1566 — the upstream LINK watch. The first async task in the table,
        // which is the whole reason the runner owns an overlap guard and an
        // async-rejection catch: one slow remote must not stack sweeps, and a
        // network failure must not take the daemon down.
        //
        // 10 min: an upstream issue is not a live feed, and every coupled
        // ticket costs one request per tick. `runAtBoot: false` — a restart is
        // not a reason to hammer the remote, and under `tsx watch` restarts are
        // frequent.
        name: "upstream-watch",
        everyMs: 10 * MINUTE,
        runAtBoot: false,
        run: async () => { await runUpstreamWatch(); },
    },
];

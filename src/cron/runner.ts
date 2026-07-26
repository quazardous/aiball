/**
 * #1566 — the periodic-task runner.
 *
 * Before this, `daemon.ts` wired each recurring job by hand: a boot call, a
 * `setInterval(...).unref()`, and a comment explaining the cadence. That held
 * because all three jobs share properties the next one won't:
 *
 *   - they are **synchronous**, so a tick always finishes before the next fires
 *     and a throw can't become an unhandled rejection;
 *   - each hand-rolls its own `try/catch`;
 *   - therefore none of them can overlap.
 *
 * The upstream sync poller breaks all three at once (async by nature, can
 * outlast its interval, can reject across an `await`). Rather than let each
 * task re-invent the same guards, the runner owns them once:
 *
 *   - **catch** — sync throws AND async rejections, per task, never fatal;
 *   - **overlap guard** — a tick is SKIPPED (not queued) while the previous one
 *     is still in flight, so a slow task can't pile up copies of itself;
 *   - **boot run** — opt-out, for jobs that must catch up on a missed deadline;
 *   - **kill switch** — evaluated per tick, so an env flag flips without a restart.
 *
 * It also records what every operator asks at 3am: when each task last ran, how
 * long it took, what it last failed with, and when it is next due. That's what
 * `GET /api/health` exposes — a table in the source is only half of "readable".
 */

export interface CronTask {
    /** Stable identifier. Shows up in logs and in the health payload. */
    name: string;
    /** Cadence in milliseconds. */
    everyMs: number;
    /** Run once at startup before the first interval tick. Default true. */
    runAtBoot?: boolean;
    /**
     * Checked before EVERY tick (boot run included). Returning false skips the
     * tick without disabling the task, so a flag can be flipped at runtime.
     * Absent = always enabled.
     */
    enabled?: () => boolean;
    /** The work. May be sync or async; both are guarded. */
    run: () => void | Promise<void>;
}

/** Per-task observability, surfaced by `GET /api/health`. */
export interface CronTaskStatus {
    name: string;
    every_ms: number;
    /** False while a kill switch holds it off. */
    enabled: boolean;
    /** A tick is currently in flight (only ever true for async tasks). */
    running: boolean;
    runs: number;
    /** Ticks skipped because the previous one was still running. */
    skipped: number;
    last_run_at: string | null;
    last_duration_ms: number | null;
    /** Message of the last failure, or null if it has never failed. */
    last_error: string | null;
    last_error_at: string | null;
    next_due_at: string | null;
}

interface TaskState {
    task: CronTask;
    running: boolean;
    runs: number;
    skipped: number;
    lastRunAt: number | null;
    lastDurationMs: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    nextDueAt: number | null;
}

const states = new Map<string, TaskState>();

/** Never let a task's own failure take the daemon down. */
function record(st: TaskState, startedAt: number, err?: unknown): void {
    st.lastDurationMs = Date.now() - startedAt;
    st.running = false;
    if (err !== undefined) {
        st.lastError = err instanceof Error ? err.message : String(err);
        st.lastErrorAt = Date.now();
        console.error(`[cron:${st.task.name}] failed:`, err);
    }
}

function tick(st: TaskState): void {
    if (st.task.enabled && !st.task.enabled()) return;
    if (st.running) {
        // Skip, don't queue: a task that consistently outlasts its interval
        // would otherwise accumulate overlapping copies of itself.
        st.skipped++;
        console.warn(
            `[cron:${st.task.name}] previous run still in flight — tick skipped (${st.skipped} so far)`,
        );
        return;
    }
    st.running = true;
    st.runs++;
    const startedAt = Date.now();
    st.lastRunAt = startedAt;
    st.nextDueAt = startedAt + st.task.everyMs;
    let out: void | Promise<void>;
    try {
        out = st.task.run();
    } catch (e) {
        record(st, startedAt, e);
        return;
    }
    // A sync task is already done here. An async one resolves later, and its
    // rejection MUST be caught — an unhandled rejection inside setInterval
    // kills the process.
    if (out && typeof (out as Promise<void>).then === "function") {
        void (out as Promise<void>).then(
            () => record(st, startedAt),
            (e) => record(st, startedAt, e),
        );
    } else {
        record(st, startedAt);
    }
}

/**
 * Start every task. Returns a stop function (used by tests; the daemon relies
 * on `.unref()` so the timers never hold the process open).
 */
export function startScheduler(tasks: readonly CronTask[]): () => void {
    const timers: NodeJS.Timeout[] = [];
    for (const task of tasks) {
        if (states.has(task.name)) {
            throw new Error(`cron: duplicate task name "${task.name}"`);
        }
        const st: TaskState = {
            task,
            running: false,
            runs: 0,
            skipped: 0,
            lastRunAt: null,
            lastDurationMs: null,
            lastError: null,
            lastErrorAt: null,
            nextDueAt: null,
        };
        states.set(task.name, st);
        if (task.runAtBoot !== false) tick(st);
        else st.nextDueAt = Date.now() + task.everyMs;
        const t = setInterval(() => tick(st), task.everyMs);
        t.unref();
        timers.push(t);
    }
    return () => {
        for (const t of timers) clearInterval(t);
        for (const task of tasks) states.delete(task.name);
    };
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Snapshot for diagnostics. Empty before `startScheduler` runs (CLI, tests). */
export function schedulerStatus(): CronTaskStatus[] {
    return [...states.values()].map((st) => ({
        name: st.task.name,
        every_ms: st.task.everyMs,
        enabled: st.task.enabled ? st.task.enabled() : true,
        running: st.running,
        runs: st.runs,
        skipped: st.skipped,
        last_run_at: iso(st.lastRunAt),
        last_duration_ms: st.lastDurationMs,
        last_error: st.lastError,
        last_error_at: iso(st.lastErrorAt),
        next_due_at: iso(st.nextDueAt),
    }));
}

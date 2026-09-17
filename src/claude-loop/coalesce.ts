/**
 * #2682 — a loop refreshed its bar counters on every SSE ping, hello and
 * heartbeat: three daemon requests each time, several a second when a comment
 * notifies many agents. Coalescing keeps the bar current without the storm:
 * one run at a time, runs at least `minGapMs` apart, and a request that arrives
 * while running or too soon is not lost — it becomes ONE trailing run.
 */
export function coalesce(
    run: () => Promise<void>,
    minGapMs: number,
    clock: { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown } = { now: Date.now, setTimeout },
): () => Promise<void> {
    let running: Promise<void> | null = null;
    let lastStart = -Infinity;
    let trailing = false;
    let timerArmed = false;

    const start = (): Promise<void> => {
        lastStart = clock.now();
        trailing = false;
        running = run().catch(() => { /* best-effort, like the callers */ }).finally(() => {
            running = null;
            if (trailing) schedule();
        });
        return running;
    };
    const schedule = (): void => {
        if (timerArmed) return;
        const wait = Math.max(0, lastStart + minGapMs - clock.now());
        timerArmed = true;
        clock.setTimeout(() => {
            timerArmed = false;
            if (running) { trailing = true; return; }
            void start();
        }, wait);
    };

    return () => {
        if (running) { trailing = true; return running; }
        if (clock.now() - lastStart >= minGapMs && !timerArmed) return start();
        trailing = true;
        schedule();
        return Promise.resolve();
    };
}

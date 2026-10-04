/**
 * #3074 / #3117 / #3540 — the wait before a restart of Claude for an update:
 * until Claude is idle, until a deadline (an order without `when_idle` gives up
 * after a few minutes), or until a human cancels the order. On its own so the
 * three ends are testable without a kernel.
 */
export type RestartWaitEnd = "idle" | "timeout" | "cancelled";

export async function waitForRestart(o: {
    /** Claude works (or the pane says nothing yet): keep waiting. */
    busy: () => boolean;
    /** A human cancelled the order. */
    cancelled: () => boolean;
    /** When to give up; Infinity with `when_idle`. */
    untilMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    stepMs?: number;
}): Promise<RestartWaitEnd> {
    const now = o.now ?? Date.now;
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (;;) {
        if (o.cancelled()) return "cancelled";
        if (!o.busy()) return "idle";
        if (now() > o.untilMs) return "timeout";
        await sleep(o.stepMs ?? 2000);
    }
}

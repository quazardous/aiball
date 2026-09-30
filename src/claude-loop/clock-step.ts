/**
 * #3416 — the system clock stepped: the wall clock moved by something else
 * than the time that passed. Read by comparing, between two ticks, what the
 * wall clock says elapsed with what the monotonic clock says.
 *
 * Why the kernel cares: it holds many wall-clock readings in memory ("not
 * before N s since the last try", "until that time"). A clock set BACK leaves
 * each of them waiting for the size of the step — Windows correcting a clock
 * two hours ahead left a loop disconnected for two hours. A clock set forward,
 * or a machine resuming from sleep (the monotonic clock stops, the wall clock
 * does not), only makes them come due at once, which is what a resume should do.
 *
 * Pure: the caller gives both readings.
 */
export const CLOCK_STEP_THRESHOLD_MS = 5_000;

export class ClockStepDetector {
    private last: { wallMs: number; monoMs: number } | null = null;

    constructor(private readonly thresholdMs: number = CLOCK_STEP_THRESHOLD_MS) {}

    /**
     * The step since the last call, in milliseconds (negative: set back), or
     * null when the two clocks agree within the threshold. The first call only
     * takes its reference.
     */
    check(wallMs: number, monoMs: number): number | null {
        const prev = this.last;
        this.last = { wallMs, monoMs };
        if (!prev) return null;
        const step = (wallMs - prev.wallMs) - (monoMs - prev.monoMs);
        return Math.abs(step) >= this.thresholdMs ? Math.round(step) : null;
    }
}

/**
 * #3257 — when the heartbeat, the loop's anti-stuck fallback, tries a wake.
 *
 * `turn:settled` owns the drain cadence and announces its next drain as the
 * countdown (`nextWakeAtMs`); the heartbeat stays out of its way while one is
 * due. But a countdown nobody honours — the turn machine stopped settling —
 * must not keep it out forever: that is the wedge the fallback exists for.
 * Past its time by more than one tempo, it no longer counts.
 */
export function heartbeatShouldWake(nextWakeAtMs: number | null, nowMs: number, tempoMs: number): "no-countdown" | "overdue" | null {
    if (nextWakeAtMs === null) return "no-countdown";
    return nowMs - nextWakeAtMs > tempoMs ? "overdue" : null;
}

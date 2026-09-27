/**
 * #3157 — when the loop tells the daemon its phase (`consumer.push_state`):
 * on every heartbeat, the freshness signal, and also the moment the phase
 * changes, so an agent's state never lags a transition by a heartbeat. A loop
 * that starts says `boot` at once; one whose kernel reloads onto a Claude
 * already running (a reattach) says nothing until its phase moves, so its
 * `state_since` stays where it was.
 */
export class PhaseReport {
    private last: string | null = null;

    constructor(private readonly push: (phase: string) => void, opts: { fresh: boolean }) {
        if (opts.fresh) this.report("boot");
    }

    /** A new view: say its phase if it differs from the last one said. */
    onPhase(phase: string): void {
        if (phase !== this.last) this.report(phase);
    }

    /** The heartbeat: always said, the daemon's freshness signal. */
    onHeartbeat(phase: string): void {
        this.report(phase);
    }

    private report(phase: string): void {
        this.last = phase;
        try { this.push(phase); } catch { /* the next heartbeat tries again */ }
    }
}

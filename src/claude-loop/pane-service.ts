/**
 * #647 Slice 1 — PaneService : observable in-memory store for pane-derived
 * markers (what's visible on the claude pane). Replaces the scattered
 * marker-files model (`resume-picker-active`, `pane-compacting`, …) with a
 * single typed service that consumers can `get(m)` or `subscribe(m, cb)`.
 *
 * Scope (slice 1, david `kgf8qe` "spinoff ok") :
 *   - the enum + the service class + tests, fully greenfield
 *   - NO wiring yet : slice 2 = pty-proxy emits via proxy-events.sock,
 *     slice 3 = state.ts dispatcher routes events to setMarker
 *   - NO drop of the legacy marker-files : slice 6 once stable
 *
 * Design rules (david `2cpcaq` + `hhbt5a`):
 *   - markers are STRICTLY pane-derived (regex on capture-pane). No
 *     keyboard, no timer, no AFK — those live in LoopStateBus.
 *   - flat enum, no special/non-special distinction (just sucre POV
 *     consommateur).
 *   - mutex among "screen-takeover" markers (ResumeSessionPicker XOR
 *     ResumeModePicker XOR Compacting XOR Error*) is the EMITTER's
 *     responsibility ; this service offers `setExclusive(group, m)`
 *     to express it cleanly.
 */

/**
 * Every marker the claude pane can be in. Names are STRING values so
 * logs / snapshots stay human-readable ("Compacting" beats "5").
 *
 * Boolean state (always defined) :
 *   - Busy        — "esc to interrupt" visible (turn in flight)
 *   - Ready       — prompt visible & settled (idle, can be poked)
 *   - PaneReady   — initial pane probe completed (lifecycle, not idleness)
 *
 * Screen-takeover (mutually exclusive among themselves) :
 *   - ResumeSessionPicker — 1st `--resume` screen : pick which session
 *   - ResumeModePicker    — 2nd `--resume` screen : summary vs as-is
 *   - Compacting          — "Compacting conversation" mid-flight
 *
 * Error banners (also mutually exclusive — first matching pattern wins,
 * mirrors `error-backoff.ts:ERROR_PATTERNS`) :
 *   - ErrorRateLimit  — `Rate limited` / `temporarily limiting requests`
 *   - ErrorOverloaded — `overloaded_error` (API type token)
 *   - ErrorApiError   — `API Error` / `APIError`
 */
export const PaneMarker = {
    Busy: "Busy",
    Ready: "Ready",
    PaneReady: "PaneReady",
    ResumeSessionPicker: "ResumeSessionPicker",
    ResumeModePicker: "ResumeModePicker",
    Compacting: "Compacting",
    ErrorRateLimit: "ErrorRateLimit",
    ErrorOverloaded: "ErrorOverloaded",
    ErrorApiError: "ErrorApiError",
} as const;
export type PaneMarker = typeof PaneMarker[keyof typeof PaneMarker];

/**
 * Members of the "screen-takeover" mutex group : at most one active at
 * any moment (the pane physically can't show two pickers + a /compact at
 * once). The emitter promises this ; the service can enforce via
 * `setExclusive`.
 */
export const SCREEN_TAKEOVER_GROUP: readonly PaneMarker[] = [
    PaneMarker.ResumeSessionPicker,
    PaneMarker.ResumeModePicker,
    PaneMarker.Compacting,
] as const;

/**
 * Members of the error banner mutex group. Aligned with
 * `error-backoff.ts:ERROR_PATTERNS` — first-match-wins on the pane
 * footer.
 */
export const ERROR_GROUP: readonly PaneMarker[] = [
    PaneMarker.ErrorRateLimit,
    PaneMarker.ErrorOverloaded,
    PaneMarker.ErrorApiError,
] as const;

export type Unsubscribe = () => void;
export type MarkerListener = (active: boolean, marker: PaneMarker) => void;

/**
 * In-memory observable store. One instance per claude-loop (timer-side).
 * The emitter calls `set` / `setExclusive` ; consumers (bar renderer,
 * wake gate, log writer) call `get` / `snapshot` / `subscribe`.
 *
 * Pure data — no I/O, no fs, no proxy-events knowledge. The dispatcher
 * (slice 3) translates wire events into `set` calls on this instance.
 */
export class PaneService {
    private readonly active = new Set<PaneMarker>();
    private readonly listeners = new Map<PaneMarker, Set<MarkerListener>>();
    /** Catch-all subscribers — notified on every change. */
    private readonly anyListeners = new Set<MarkerListener>();

    get(m: PaneMarker): boolean {
        return this.active.has(m);
    }

    /**
     * Snapshot of currently-active markers. Returns a fresh Set so the
     * caller can iterate without holding a reference into the service's
     * internal state. Order is insertion order (Set guarantees) — stable
     * enough for bar rendering.
     */
    snapshot(): Set<PaneMarker> {
        return new Set(this.active);
    }

    /**
     * Toggle a marker. Notifies the marker's listeners AND the
     * catch-all listeners when the value actually flips. Idempotent —
     * setting the same value twice is a silent no-op.
     */
    set(m: PaneMarker, active: boolean): void {
        const was = this.active.has(m);
        if (was === active) return;
        if (active) this.active.add(m);
        else this.active.delete(m);
        this.notify(m, active);
    }

    /**
     * Set ONE marker in a mutex group to true, clear every other member.
     * Pass null to clear the whole group. Use for screen-takeover
     * transitions ("now we're on the summary picker, not the session
     * picker") so the emitter doesn't have to track which one was set.
     *
     * Notifications fire per-marker — a single transition flipping
     * `ResumeSessionPicker → ResumeModePicker` produces two events
     * (session→false, mode→true), in that order.
     */
    setExclusive(group: readonly PaneMarker[], m: PaneMarker | null): void {
        if (m !== null && !group.includes(m)) {
            throw new Error(`setExclusive: marker ${m} is not a member of the given group`);
        }
        for (const member of group) {
            if (member !== m) this.set(member, false);
        }
        if (m !== null) this.set(m, true);
    }

    /**
     * Subscribe to changes of a specific marker. Returns an unsubscribe
     * function. The listener is NOT called with the current value at
     * subscribe time — callers wanting initial state should `get()`
     * first.
     */
    subscribe(m: PaneMarker, cb: MarkerListener): Unsubscribe {
        let s = this.listeners.get(m);
        if (!s) {
            s = new Set();
            this.listeners.set(m, s);
        }
        s.add(cb);
        return () => { s!.delete(cb); };
    }

    /**
     * Subscribe to EVERY marker change. Useful for the bar's
     * "re-render on any change" loop, and for the debug snapshot logger.
     */
    subscribeAny(cb: MarkerListener): Unsubscribe {
        this.anyListeners.add(cb);
        return () => { this.anyListeners.delete(cb); };
    }

    private notify(m: PaneMarker, active: boolean): void {
        const targeted = this.listeners.get(m);
        if (targeted) {
            // Snapshot the listener set so a listener that subscribes /
            // unsubscribes during the callback doesn't trip iteration.
            for (const cb of [...targeted]) {
                try { cb(active, m); } catch { /* swallow — observer model */ }
            }
        }
        for (const cb of [...this.anyListeners]) {
            try { cb(active, m); } catch { /* swallow */ }
        }
    }
}

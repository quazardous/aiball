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
    Resuming: "Resuming",
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
    PaneMarker.Resuming,
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

import { Observable, type Unsubscribe } from "./observable.js";
export type { Unsubscribe } from "./observable.js";
export type MarkerListener = (active: boolean, marker: PaneMarker) => void;

/**
 * In-memory observable store. One instance per claude-loop (timer-side).
 * The emitter calls `set` / `setExclusive` ; consumers (bar renderer,
 * wake gate, log writer) call `get` / `snapshot` / `subscribe`.
 *
 * Pure data — no I/O, no fs, no proxy-events knowledge.
 *
 * #649 Slice 1 : converged onto `Observable<T>` primitive. Each marker
 * is backed by its own `Observable<boolean>` — gives us idempotence,
 * throw-safety, and re-entrant unsubscribe for free. The cross-marker
 * `subscribeAny` and `setExclusive` are PaneService-specific glue on top.
 */
export class PaneService {
    private readonly markers = new Map<PaneMarker, Observable<boolean>>();
    /** Catch-all subscribers — notified on every change across markers. */
    private readonly anyListeners = new Set<MarkerListener>();

    private obs(m: PaneMarker): Observable<boolean> {
        let o = this.markers.get(m);
        if (!o) {
            o = new Observable<boolean>(false);
            this.markers.set(m, o);
        }
        return o;
    }

    get(m: PaneMarker): boolean {
        return this.markers.get(m)?.get() ?? false;
    }

    /**
     * Snapshot of currently-active markers. Returns a fresh Set so the
     * caller can iterate without holding a reference into the service's
     * internal state. Order is insertion order (Set guarantees) — stable
     * enough for bar rendering.
     */
    snapshot(): Set<PaneMarker> {
        const out = new Set<PaneMarker>();
        for (const [m, o] of this.markers) if (o.get()) out.add(m);
        return out;
    }

    /**
     * Toggle a marker. Notifies the marker's listeners AND the
     * catch-all listeners when the value actually flips. Idempotent —
     * setting the same value twice is a silent no-op (Observable<T> guarantee).
     */
    set(m: PaneMarker, active: boolean): void {
        const o = this.obs(m);
        const was = o.get();
        if (was === active) return;
        o.set(active);
        // Fan out to catch-all listeners (cross-marker) — per-marker
        // subscribers already fired via o.set(); we add the wide net.
        for (const cb of [...this.anyListeners]) {
            try { cb(active, m); } catch { /* observer model */ }
        }
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
     * first. Delegates to the marker's Observable<boolean>.
     */
    subscribe(m: PaneMarker, cb: MarkerListener): Unsubscribe {
        return this.obs(m).subscribe((active) => cb(active, m));
    }

    /**
     * Subscribe to EVERY marker change. Useful for the bar's
     * "re-render on any change" loop, and for the debug snapshot logger.
     */
    subscribeAny(cb: MarkerListener): Unsubscribe {
        this.anyListeners.add(cb);
        return () => { this.anyListeners.delete(cb); };
    }
}

/**
 * Per-process singleton (#647 Slice 3). The timer hydrates this on boot
 * and pushes updates after each pane probe. Other consumers (slice 4 :
 * the bar) read it via `getPaneService().get(...)` / `snapshot()`.
 *
 * Per-process : session-start-hook lives in a different process and
 * has its own (unread) singleton — it pushes to the timer's instance via
 * proxy-events (slice 5). For now the marker files remain the cross-
 * process bridge.
 */
let _singleton: PaneService | null = null;
export function getPaneService(): PaneService {
    if (!_singleton) _singleton = new PaneService();
    return _singleton;
}

/** Reset the singleton — tests only, never call in prod paths. */
export function resetPaneServiceForTests(): void {
    _singleton = new PaneService();
}

/**
 * #647 Slice 4 — short label for the tmux bar's `[…:label]` segment when
 * a screen-takeover or error marker is active. Returns null when only
 * routine markers (Busy/Ready/PaneReady) are present — the bar then
 * falls back to its usual count / user-grace info.
 *
 * Priority is mutex-aware : at most one screen-takeover and one error
 * can be active at a time (PaneService.setExclusive enforces it) ;
 * screen-takeover beats error if both happen to coexist.
 */
export function paneMarkerBarInfo(svc?: PaneService): string | null {
    const s = (svc ?? getPaneService()).snapshot();
    if (s.has(PaneMarker.ResumeSessionPicker)) return "picker:session";
    if (s.has(PaneMarker.ResumeModePicker)) return "picker:mode";
    if (s.has(PaneMarker.Resuming)) return "resuming";
    if (s.has(PaneMarker.Compacting)) return "compacting";
    if (s.has(PaneMarker.ErrorRateLimit)) return "err:rate-limit";
    if (s.has(PaneMarker.ErrorOverloaded)) return "err:overloaded";
    if (s.has(PaneMarker.ErrorApiError)) return "err:api";
    return null;
}

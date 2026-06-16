/**
 * #845 — Watcher contracts for the pane observation layer.
 *
 * Three responsibilities, three layers (david `9kjxad`, `f48hnz`,
 * "orchestrateur c'est juste un manager actif…") :
 *
 *   - PaneWatcher       — DUMB observer. Pure function of `(paneText, ctx)`
 *                         that maintains internal state + emits transition
 *                         events. No knowledge of zones, no activation
 *                         logic, no decisions.
 *
 *   - PaneObserver      — registry + dispatcher (see `./observer.ts`).
 *                         Holds zones (named bags of watchers) and the set
 *                         of currently-active zones. On each tick it
 *                         dispatches the pane text to the watchers in
 *                         active zones (dedup'd if a watcher belongs to
 *                         multiple zones, david: "un watcher peut être
 *                         multi-zone").
 *
 *   - State machine     — external consumer. Subscribes to watcher events
 *                         + bus signals to decide which zones to enter or
 *                         leave on the observer. The orchestrator never
 *                         decides on its own ; it's told what to do.
 */

export interface PaneScanCtx {
    /** Wall-clock now-ms for time-sensitive watchers (latches, debounces). */
    nowMs: number;
    /** True iff the loop is still in the boot phase (the SM hasn't sealed
     *  bootComplete yet). Watchers may use it to widen footer scopes or
     *  adapt thresholds — purely advisory, no activation logic depends on
     *  it (that's the orchestrator's zone job). */
    isBoot?: boolean;
    /** #993 — tmux pane cursor position (0-based, visible-screen relative),
     *  when probed. Needed to tell real typed input apart from Claude's greyed
     *  ghost-suggestions in the prompt box : typed text sits BEFORE the cursor,
     *  the suggestion AFTER it. Undefined when not probed (replay/tests →
     *  callers fall back to whole-line text detection). */
    cursorX?: number;
    cursorY?: number;
}

export interface PaneWatcherEvents<TState> {
    /** Fired on every state transition (next != prev). `prev` is null on
     *  the very first observe. */
    change: (next: TState, prev: TState | null) => void;
    /** Optional : fired when the state transitions to a domain-specific
     *  "active" sense — e.g. compacting becomes true, picker becomes
     *  visible. The watcher decides what "active" means by emitting. */
    begin?: (state: TState) => void;
    /** Optional : fired when the state transitions out of "active". */
    end?: (state: TState) => void;
    /** Optional : fired on intermediate updates while still active (e.g.
     *  compacting percentage moves). */
    progress?: (state: TState) => void;
    /** #898 david `<chat>` : "des qu'on est busy on detecte le esc to
     *  interrupt ça recycle une phase éventuellement morte". Fired on
     *  EVERY observe() call where the watcher classifies as active
     *  (= regardless of state change). Lets a consumer treat the
     *  observation itself as a heartbeat for stale-detection : no
     *  `seen` for X seconds = phase morte. Contrast with `begin`/`end`
     *  qui ne firent qu'aux transitions de flank. */
    seen?: (state: TState) => void;
}

export interface PaneWatcher<TState> {
    /** Stable id for logging + dedup in the orchestrator. */
    readonly name: string;
    /** Inspect the pane and update internal state. Emits the appropriate
     *  events on transitions. Idempotent : same `(paneText, ctx)` twice
     *  in a row produces the same state, no re-emit. */
    observe(paneText: string, ctx: PaneScanCtx): TState;
    /** Read the current state without observing. */
    snapshot(): TState;
    /** Subscribe to an event. Returns an unsubscribe closure. */
    on<E extends keyof PaneWatcherEvents<TState>>(
        event: E,
        cb: NonNullable<PaneWatcherEvents<TState>[E]>,
    ): () => void;
    /** Drop all internal state + listeners. Tests + explicit out-of-band
     *  resets. */
    reset(): void;
}

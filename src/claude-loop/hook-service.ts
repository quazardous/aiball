/**
 * #652 Slice 1 — HookService : observable in-memory façade over Claude
 * Code hook fires. Hooks (session-start-hook, stop-hook, pretooluse-hook,
 * etc.) are spawn-per-call subprocesses today, but the in-process timer
 * is the long-running consumer that decides what to do. This service
 * gives the timer a typed event stream + a boot-queue so events that
 * arrive while the loop is still booting don't get acted on prematurely
 * (the root cause of the [boot:session?] oscillation in #650).
 *
 * Mirrors the PaneService (#647) / AfkService (#649) pattern : one
 * observable singleton per process, subscribers receive snapshots,
 * mutations go through typed methods (`emit`). The queue toggle is a
 * HookService-specific knob — when `setBootQueueing(true)` is on, every
 * `emit` is stashed; `drainBoot()` flushes the queue back through the
 * normal notification path.
 *
 * Scope of slice 1 : the service + types + tests only. No wiring yet
 * (slice 2 = pull state proto, slice 3 = migrate session-start-hook,
 * slice 4 = migrate pretooluse-hook, slice 5 = drop direct paints).
 */
import { Observable, type Unsubscribe } from "./observable.js";

/**
 * Source flavor for `SessionStart` — mirrors Claude Code's own SessionStart
 * payload `source` field. `compact` is observed when /compact triggers a
 * fresh session under the hood ; `clear` when /clear is invoked.
 */
export type SessionStartSource = "startup" | "resume" | "compact" | "clear";

/**
 * Hook event union. Each variant matches a Claude Code hook fire ; the
 * `kind` field is the discriminant. `at_ms` is the wall-clock timestamp
 * at emit (set by the caller, NOT auto-stamped, so a hook that fires
 * during a boot queue and gets drained later still carries the original
 * timing). Subsequent slices add payload fields as needed (e.g. tool
 * verdict context on `PreToolUse`).
 */
export type HookEvent =
    | { kind: "SessionStart"; source: SessionStartSource; at_ms: number }
    | { kind: "Stop"; at_ms: number }
    | { kind: "PreToolUse"; tool_name: string; at_ms: number }
    /**
     * #652 Slice 6 — the user (or auto-wake) submitted a prompt ; claude
     * is about to process. The bar subscriber typically flips to BUSY.
     * `from_auto_wake` distinguishes the timer's own send-keys (= still
     * autonomous) from a human-typed submission ; the user-prompt-submit
     * hook computes it via the wake-in-flight marker (#B.180).
     */
    | { kind: "UserPromptSubmit"; from_auto_wake: boolean; at_ms: number };

/** Subscriber callback — receives every event in fire order. */
export type HookListener = (event: HookEvent) => void;

/**
 * Per-process observable hook stream + boot queue. Greenfield ; no
 * mutation surface other than `emit` and the queue toggle. Consumers
 * subscribe via `subscribe` and decide what to do with each event.
 *
 * Queue semantics : while `bootQueueing` is on, `emit` does NOT notify
 * subscribers immediately — events stack in `_queue` instead. The
 * timer flips the queue off at bootEnded via `drainBoot()`, which
 * notifies all stashed events in FIFO order. Events emitted AFTER the
 * drain (queue off again) notify immediately.
 *
 * Observable<boolean> wraps the queueing flag so a consumer that needs
 * to know "are we live yet ?" can subscribe to transitions instead of
 * polling. Mirrors PaneService's use of Observable<T> for cross-cut
 * state.
 */
export class HookService {
    private readonly _bootQueueing = new Observable<boolean>(false);
    private readonly _queue: HookEvent[] = [];
    private readonly _listeners = new Set<HookListener>();

    /** Subscribe to every event. Returns an unsubscribe function. The
     *  listener fires for events emitted AFTER subscribe + for events
     *  drained from the boot queue when `drainBoot()` runs. */
    subscribe(cb: HookListener): Unsubscribe {
        this._listeners.add(cb);
        return () => { this._listeners.delete(cb); };
    }

    /** Subscribe to the boot-queueing flag — fires on every transition
     *  (on → off, off → on). Useful for the bar / state machine to know
     *  when the loop crosses the boot boundary. */
    subscribeBootQueueing(cb: (queueing: boolean) => void): Unsubscribe {
        return this._bootQueueing.subscribe(cb);
    }

    /** Current boot-queueing flag value. */
    isBootQueueing(): boolean {
        return this._bootQueueing.get();
    }

    /** Number of events currently sitting in the queue. Useful for
     *  diagnostics ; the queue is normally drained at bootEnded so
     *  this is 0 during normal operation. */
    queueLength(): number {
        return this._queue.length;
    }

    /** Toggle the boot-queue. When `true`, subsequent `emit` calls
     *  enqueue instead of notifying. When `false`, the queue is NOT
     *  drained automatically — call `drainBoot()` for that. The
     *  separation lets the caller decide ordering vs other boot
     *  cleanup. */
    setBootQueueing(on: boolean): void {
        this._bootQueueing.set(on);
    }

    /** Emit a hook event. If the boot queue is on, the event stacks.
     *  Otherwise every subscriber is notified in registration order.
     *  Listener exceptions are swallowed (observer model — one bad
     *  subscriber must not kill the others or block the emit). */
    emit(event: HookEvent): void {
        if (this._bootQueueing.get()) {
            this._queue.push(event);
            return;
        }
        this.notify(event);
    }

    /** Drain the boot queue : notify every stashed event in FIFO order,
     *  then clear the queue. Does NOT change the queueing flag — the
     *  caller decides whether to also flip it off (typical pattern :
     *  setBootQueueing(false) → drainBoot()). Idempotent on an empty
     *  queue. Returns the number of events drained. */
    drainBoot(): number {
        if (this._queue.length === 0) return 0;
        const batch = this._queue.splice(0);
        for (const ev of batch) this.notify(ev);
        return batch.length;
    }

    /** Snapshot of the queue contents (defensive copy). Useful for
     *  tests + diagnostics ; consumers should subscribe rather than
     *  poll for live state. */
    snapshot(): HookEvent[] {
        return [...this._queue];
    }

    private notify(event: HookEvent): void {
        for (const cb of [...this._listeners]) {
            try { cb(event); } catch { /* observer model — swallow */ }
        }
    }
}

/** Per-process singleton. Same pattern as PaneService / AfkService. */
let _singleton: HookService | null = null;
export function getHookService(): HookService {
    if (!_singleton) _singleton = new HookService();
    return _singleton;
}

/** Reset the singleton — tests only, never call in prod paths. */
export function resetHookServiceForTests(): void {
    _singleton = new HookService();
}

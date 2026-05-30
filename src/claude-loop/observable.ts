/**
 * #649 Slice 1 — Observable<T> : tiny generic store with idempotent
 * `set` + throw-safe + re-entrant `subscribe`. Extracted from
 * `pane-service.ts` (which used the same machinery per-marker) so
 * `AfkService` (`Observable<"off"|"10m"|"inf">`) and `InterruptedSignal`
 * (`Observable<boolean>`) can reuse it. PaneService also converges
 * onto this primitive (Map<PaneMarker, Observable<boolean>>).
 *
 * Behavior guarantees (mirrored from PaneService listener tests) :
 *   - `set` is idempotent : setting the same value twice is a silent
 *     no-op (uses `Object.is` for equality — handles NaN + null/undef
 *     cases sanely).
 *   - Subscribers are NOT called with the current value at subscribe
 *     time — callers wanting initial state should `get()` first.
 *   - A listener that throws does NOT break sibling listeners
 *     (try/catch around each call, errors swallowed by design — this
 *     is the observer model).
 *   - A listener that subscribes / unsubscribes during its own
 *     callback doesn't trip iteration (snapshot the set before
 *     iterating).
 *
 * David `m5g435`+`e8bpmh` : value pas forcément booléenne (generic T)
 * et pattern partagé entre services hétérogènes.
 */

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

export class Observable<T> {
    private _value: T;
    private readonly _listeners = new Set<Listener<T>>();

    constructor(initial: T) {
        this._value = initial;
    }

    get(): T {
        return this._value;
    }

    set(value: T): void {
        if (Object.is(this._value, value)) return;
        this._value = value;
        this.notify(value);
    }

    subscribe(cb: Listener<T>): Unsubscribe {
        this._listeners.add(cb);
        return () => { this._listeners.delete(cb); };
    }

    /** Count of currently registered listeners — for tests / debug only. */
    listenerCount(): number {
        return this._listeners.size;
    }

    private notify(value: T): void {
        // Snapshot before iterate : a listener that subscribes /
        // unsubscribes during the callback must not trip iteration.
        for (const cb of [...this._listeners]) {
            try { cb(value); } catch { /* observer model — swallow */ }
        }
    }
}

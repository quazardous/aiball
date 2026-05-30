/**
 * #649 Slice 2 — AfkService : typed observable façade over the AFK state
 * machine (F9 toggle, 3 states). Greenfield ; slice 4 will wire it into
 * the bar countdown + wake gate. The marker file (`<sd>/afk`) remains
 * the cross-process source of truth for now — slice 5 drops it.
 *
 * State model mirrors `state.ts:readAfkState` :
 *   - "off"      — pas en AFK (default, autonomous loop pings au gré
 *                  du heartbeat)
 *   - "wait_10m" — NOT AFK 10m countdown (typing l'arme/refresh, F9
 *                  l'avance vers wait_inf, expiry auto → off)
 *   - "wait_inf" — NOT AFK ∞ (F9 explicite, ne se relâche que sur F9)
 *
 * `expiryMs()` retourne le timestamp UNIX ms du moment où wait_10m
 * expire — null pour off / wait_inf. La barre subscribe pour repaint
 * le countdown ; l'expiry est consulté en pull à chaque tick visible.
 *
 * David `m5g435` : pattern observable partagé. `e8bpmh` : valeur pas
 * forcément booléenne (ici Observable<AfkState>).
 */
import { Observable, type Unsubscribe } from "./observable.js";

export type AfkState = "off" | "wait_10m" | "wait_inf";

export interface AfkSnapshot {
    state: AfkState;
    expiryMs: number | null;
}

export class AfkService {
    private readonly _state: Observable<AfkState>;
    private _expiryMs: number | null = null;

    constructor(initial: AfkState = "off", expiryMs: number | null = null) {
        this._state = new Observable<AfkState>(initial);
        this._expiryMs = initial === "wait_10m" ? expiryMs : null;
    }

    /** Current state value. */
    getState(): AfkState {
        return this._state.get();
    }

    /** UNIX ms expiry for the wait_10m countdown ; null when off / wait_inf. */
    expiryMs(): number | null {
        return this._expiryMs;
    }

    /** Convenience getter — `{ state, expiryMs }` in one read, for the bar
     *  and inspect commands that want both. */
    snapshot(): AfkSnapshot {
        return { state: this._state.get(), expiryMs: this._expiryMs };
    }

    /** Remaining countdown in ms (positive while running, 0 once expired,
     *  null when no countdown is active). Caller should still treat a
     *  positive value crossing zero as "should re-read / sync from file"
     *  in slice 2 ; slice 4 will wire the auto-expiry transition. */
    remainingMs(nowMs: number = Date.now()): number | null {
        if (this._state.get() !== "wait_10m" || this._expiryMs === null) return null;
        return Math.max(0, this._expiryMs - nowMs);
    }

    /** Subscribe to state transitions. `cb` receives the NEW state on
     *  every flip. Not called with the current value at subscribe time —
     *  consumers wanting initial state should `getState()` first. The
     *  countdown SECOND-BY-SECOND animation is NOT a transition — the
     *  bar repaints on its own timer and reads `remainingMs()` then. */
    subscribe(cb: (state: AfkState) => void): Unsubscribe {
        return this._state.subscribe(cb);
    }

    setOff(): void {
        this._expiryMs = null;
        this._state.set("off");
    }

    set10m(expiryMs: number): void {
        this._expiryMs = expiryMs;
        this._state.set("wait_10m");
    }

    setInf(): void {
        this._expiryMs = null;
        this._state.set("wait_inf");
    }
}

/**
 * Per-process singleton (mirrors getPaneService pattern, slice 4 wires it).
 */
let _singleton: AfkService | null = null;
export function getAfkService(): AfkService {
    if (!_singleton) _singleton = new AfkService();
    return _singleton;
}

export function resetAfkServiceForTests(): void {
    _singleton = new AfkService();
}

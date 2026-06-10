/**
 * #893 Slice A — HookWatcher : abstraction observable des hook fires,
 * stylée comme une SM watcher (XState `actor.on(event, cb)` pattern).
 *
 * David `<chat>` :
 * > "il y a un hook watcher à créer qui balance un signal dans la state
 * >  machine. le hook ne fait plus rien à part ça je pense"
 *
 * Architecture cible :
 *
 *   [hook subprocess] → emitHookEventToTimer → dispatchProxyEvent
 *                                                    │
 *                                                    ▼
 *                                            [HookWatcher.emit]
 *                                                    │ emit hook:<name>
 *                                                    ▼
 *                                 [consumers : IdleController, Boot, etc.]
 *                                   via hookWatcher.on("hook:stop", cb)
 *
 * Vs `HookService` (legacy) : même substrat (= ws back-channel des hooks),
 * mais API style watcher (`on("hook:<name>", cb)` au lieu de
 * `subscribe(ev => switch(ev.kind))`). Boot-queue dropped — le respawn
 * handoff (#884 snapshots) couvre la persistance des in-flight events,
 * et les SM consumers gèrent leur propre gating (BootController gated,
 * IdleController unknown state).
 *
 * Slice A scope : la classe + le singleton + les types. La composition
 * root branche `HookService.subscribe → hookWatcher.emit` (= bridge non-
 * breaking, les consumers HookService restent valides). Slices B/C/D :
 * slim les subprocesses + migrer les consumers + drop HookService.
 *
 * SM-NETWORK contract : événements naming = `hook:<event_name>` style.
 * Payload typé par variant. Aucune logique métier ici (ni IPC write ni
 * decision) — pure relay de signal vers les consumers (= le purity
 * contract des controllers s'étend aux watchers : separation of concerns).
 */

import type { SessionStartSource } from "./hook-service.js";

/** Payload variants par event name. Le `:hook` préfixe sert de namespace
 *  cross-SM (vs `:idle`, `:wake`, `:afk` etc. dans les SM controllers). */
export type HookWatcherEvent =
    | { type: "hook:session_start"; source: SessionStartSource; atMs: number; pickerSession?: boolean; pickerMode?: boolean }
    | { type: "hook:user_prompt_submit"; fromAutoWake: boolean; atMs: number }
    | { type: "hook:stop"; atMs: number; busyDeferUntilMs?: number | null }
    | { type: "hook:pretooluse"; toolName: string; atMs: number };

export type HookWatcherEventName = HookWatcherEvent["type"];
export type HookWatcherListener<E extends HookWatcherEventName = HookWatcherEventName> =
    (ev: Extract<HookWatcherEvent, { type: E }>) => void;

/**
 * Observable per-process. Emit interne via `emit(ev)` (= appelé par la
 * composition root depuis le bridge HookService). Consume via `on()` qui
 * retourne un `{unsubscribe}` (= XState locus event API). Listener
 * exceptions sont swallowed (observer model — un bad subscriber ne tue
 * pas les autres ni le bridge).
 */
export class HookWatcher {
    private readonly _listeners: Map<HookWatcherEventName, Set<(ev: HookWatcherEvent) => void>> = new Map();

    /** Subscribe to a specific hook event. Returns an unsubscribe handle
     *  (XState actor.on shape — `.unsubscribe()` à appeler pour cleanup). */
    on<E extends HookWatcherEventName>(eventName: E, cb: HookWatcherListener<E>): { unsubscribe: () => void } {
        let set = this._listeners.get(eventName);
        if (!set) {
            set = new Set();
            this._listeners.set(eventName, set);
        }
        set.add(cb as (ev: HookWatcherEvent) => void);
        return {
            unsubscribe: () => {
                this._listeners.get(eventName)?.delete(cb as (ev: HookWatcherEvent) => void);
            },
        };
    }

    /** Emit an event to all subscribers of its `type`. Appelé par le
     *  bridge ou les tests. Pas exposé à l'API publique des consumers. */
    emit(ev: HookWatcherEvent): void {
        const set = this._listeners.get(ev.type);
        if (!set) return;
        for (const cb of [...set]) {
            try { cb(ev); } catch { /* observer model — swallow */ }
        }
    }

    /** Diagnostic — nombre de subscribers par event type (tests). */
    listenerCount(eventName: HookWatcherEventName): number {
        return this._listeners.get(eventName)?.size ?? 0;
    }
}

let _singleton: HookWatcher | null = null;

export function getHookWatcher(): HookWatcher {
    if (!_singleton) _singleton = new HookWatcher();
    return _singleton;
}

export function resetHookWatcherForTests(): void {
    _singleton = new HookWatcher();
}

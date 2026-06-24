/**
 * #1036 S1 — the kernel event bus : a single typed in-process event bus that
 * aggregates the runtime's named system events (boot/turn/wake/afk/typing +
 * cross-process ipc/daemon + pane + counters). Consumers subscribe through ONE
 * surface (`getKernelBus().on(name, cb)`) instead of having to know which
 * XState actor / WakeBus / notifier carries a given signal.
 *
 * Lives OUTSIDE the XState purity boundary — it is NEVER imported inside a
 * machine action (machines only `assign` + `emit`; the composition-root
 * consumers forward those emits onto this bus in S2). The bus itself is a plain
 * typed EventEmitter-like store, not an actor.
 *
 * Additive (S1) : the bus exists but nothing feeds it yet — S2 (#1053) bridges
 * the actor emits, S3 (#1054) adapts the cross-process sources, S4 (#1055) adds
 * `counters:*` + docs. The coarse `onIpcChanged` notifier in `ipc-state.ts`
 * COEXISTS — the bus does not replace it (RFC §5.Q1).
 *
 * Notify is throw-safe (snapshot the listener set before iterating, swallow
 * per-listener errors) — same observer contract as `Observable<T>` (#649).
 */

/**
 * The named system-event catalogue. Names mirror the existing XState emit names
 * (`<controller>:<event>`, cf. docs/SM-NETWORK.md) 1:1, so the S2 bridge is a
 * straight forward. The cross-process / pane / counters payloads are declared
 * here with placeholder shapes and finalised when S3/S4 wire their producers.
 */
export interface KernelEventMap {
    // in-process — XState actor emits (wired in S2)
    "boot:sealed": { loopStartMs: number; reason: "deadline" | "hook" };
    "loop:start": { loopStartMs: number };
    "turn:started": { atMs: number };
    "turn:ended": { atMs: number };
    "turn:no_turn_since": { atMs: number; reason: "session_start" | "turn_ended" };
    "turn:settled": { idleSinceMs: number };
    "wake:requested": { source: string; atMs: number };
    "wake:in_flight_started": { atMs: number };
    "wake:delivered": { phrase: string; headMessageId: number | null };
    "wake:cleared": { reason: "completed" | "ttl" };
    "wake:cooldown_expired": Record<string, never>;
    "afk:armed_10m": { expiryMs: number; prevMode: string };
    "afk:armed_inf": { prevMode: string };
    "afk:cleared": { prevMode: string; reason: "user" | "expiry" };
    "typing:started": { atMs: number };
    "typing:ended": { lastKeystrokeMs: number };
    // cross-process + pane + counters — placeholder payloads, wired in S3/S4
    "ipc:connect": { peer: string };
    "ipc:disconnect": { peer: string };
    "ipc:resync": Record<string, never>;
    "daemon:hello": { unread: number };
    "daemon:ping": { ticketId?: number };
    "daemon:control": { action: string };
    "pane:changed": Record<string, unknown>;
    "counters:refreshed": { open: number | null; backlog: number | null; events: number | null };
}

export type KernelEventName = keyof KernelEventMap;
export type Unsubscribe = () => void;

export class KernelBus {
    private readonly listeners = new Map<KernelEventName, Set<(p: unknown) => void>>();
    private readonly anyListeners = new Set<(name: KernelEventName, p: unknown) => void>();

    /** Subscribe to one named event. Returns an unsubscribe handle. */
    on<K extends KernelEventName>(name: K, cb: (p: KernelEventMap[K]) => void): Unsubscribe {
        let set = this.listeners.get(name);
        if (!set) { set = new Set(); this.listeners.set(name, set); }
        const fn = cb as (p: unknown) => void;
        set.add(fn);
        return () => { set!.delete(fn); };
    }

    /** Subscribe to EVERY event (diagnostics : log-all). Returns an unsubscribe. */
    onAny(cb: (name: KernelEventName, p: unknown) => void): Unsubscribe {
        this.anyListeners.add(cb);
        return () => { this.anyListeners.delete(cb); };
    }

    /** Emit a named event to its listeners + every `onAny` listener. Throw-safe. */
    emit<K extends KernelEventName>(name: K, payload: KernelEventMap[K]): void {
        const set = this.listeners.get(name);
        if (set) {
            // Snapshot before iterate : a listener that (un)subscribes during its
            // own callback must not trip iteration.
            for (const cb of [...set]) {
                try { cb(payload); } catch { /* observer model — swallow */ }
            }
        }
        if (this.anyListeners.size > 0) {
            for (const cb of [...this.anyListeners]) {
                try { cb(name, payload); } catch { /* swallow */ }
            }
        }
    }

    /** Drop every listener. Test helper / teardown. */
    reset(): void { this.listeners.clear(); this.anyListeners.clear(); }

    /** Listener count for a given event, or the grand total (incl. onAny). Debug/tests. */
    listenerCount(name?: KernelEventName): number {
        if (name) return this.listeners.get(name)?.size ?? 0;
        let n = this.anyListeners.size;
        for (const s of this.listeners.values()) n += s.size;
        return n;
    }
}

let singleton: KernelBus | null = null;

/** The process-wide kernel bus singleton (one kernel process per loop). */
export function getKernelBus(): KernelBus {
    if (!singleton) singleton = new KernelBus();
    return singleton;
}

/** Minimal shape of an XState actor's `.on` surface — enough to bridge its emits. */
export interface ActorLike {
    on(type: KernelEventName, cb: (ev: { type: KernelEventName } & Record<string, unknown>) => void): unknown;
}

/**
 * #1053 S2 — forward every named emit of an XState `actor` onto the kernel bus.
 * ADDITIVE : registers separate forwarding subscriptions that run alongside the
 * business `actor.on(...)` consumers — the actor stays the sole emitter, the
 * kernel just gets a copy. No-op on a null actor. `bus` defaults to the
 * singleton (overridable for tests).
 */
export function bridgeActorToKernel(
    actor: ActorLike | null | undefined,
    types: KernelEventName[],
    bus: KernelBus = getKernelBus(),
): void {
    if (!actor) return;
    for (const t of types) {
        actor.on(t, (ev) => bus.emit(t, ev as never));
    }
}

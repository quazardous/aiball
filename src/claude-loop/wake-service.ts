/**
 * WakeService — singleton façade over the `wakeMachine` XState v5 actor.
 *
 * Mirrors the `AfkService` pattern : a thin wrapper exposing typed
 * methods (`request`/`delivered`/`completed`) and a `getActor()` getter
 * for consumers wiring `actor.on(...)` to locus events. The composition
 * root in `timer.ts:mainSse` instantiates the singleton, wires the
 * ipcState bridge subscriber, and is the source of truth for the
 * input config (TTLs).
 *
 * See `docs/SM-NETWORK.md` (purity contract + `<controller>:<event_name>`
 * convention).
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { wakeMachine } from "./wake-machine.js";
import { consumePendingSnapshot } from "./respawn-state.js";

export class WakeService {
    private readonly actor: ActorRefFrom<typeof wakeMachine>;

    constructor(inFlightTtlMs?: number, coalesceWindowMs?: number, snapshot?: Snapshot<unknown>) {
        this.actor = createActor(wakeMachine, {
            input: { inFlightTtlMs, coalesceWindowMs },
            snapshot,
        });
        this.actor.start();
    }

    /** Direct actor access — used by `timer.ts` to wire the bridge
     *  subscriber + `actor.on(...)` consumers. */
    getActor(): ActorRefFrom<typeof wakeMachine> {
        return this.actor;
    }

    /** Snapshot probe — `true` when the machine is in `idle` (= safe
     *  to start a new wake). False during `inFlight` / `cooldown`. */
    isIdle(): boolean {
        return this.actor.getSnapshot().value === "idle";
    }

    /** Push a REQUEST_WAKE event. Caller should check `isIdle()` first ;
     *  events sent in non-idle states are dropped by the machine. */
    request(source: string, atMs: number = Date.now()): void {
        this.actor.send({ type: "REQUEST_WAKE", source, atMs });
    }

    /** Push a WAKE_DELIVERED event — fires when send-keys hits the
     *  pane. The machine emits `wake:delivered` for consumers to
     *  react (markMessageSeen, recordBacklogWake, etc.). */
    delivered(phrase: string, headMessageId: number | null, deliveredAtMs: number = Date.now()): void {
        this.actor.send({ type: "WAKE_DELIVERED", phrase, headMessageId, deliveredAtMs });
    }

    /** Push a WAKE_COMPLETED event — fires when the wake's side-effects
     *  have all settled (post-tryWakeInner, with `delivered=true`).
     *  Transitions to `cooldown` (= post-fire coalesce window). */
    completed(): void {
        this.actor.send({ type: "WAKE_COMPLETED" });
    }

    /** Push a WAKE_SKIPPED event — fires when tryWakeInner returned false
     *  (gate refused : zen, no work, busy-defer, etc.). Returns directly
     *  to `idle` WITHOUT cooldown so the next wake attempt isn't blocked. */
    skipped(): void {
        this.actor.send({ type: "WAKE_SKIPPED" });
    }
}

let _singleton: WakeService | null = null;

export function getWakeService(): WakeService {
    if (!_singleton) {
        let snap = consumePendingSnapshot("wake") as Snapshot<unknown> | undefined;
        // #1165 — NEVER restore into a timer-only state. `inFlight` and
        // `cooldown` exit exclusively (or primarily) via `after()` delays,
        // and XState does NOT re-arm delayed transitions when an actor is
        // started from a persisted snapshot → a kernel self-reload that
        // catches the machine in `cooldown` restored it into a state with
        // no living exit: every subsequent drain attempt was refused with
        // `wakeMachine state=cooldown` FOREVER (observed live on the skybot
        // loop, stuck 25+ min until manual intervention). Across a reload an
        // in-flight/cooling wake is moot anyway — starting fresh in `idle`
        // is safe (worst case: one wake fires a little early).
        const v = (snap as { value?: unknown } | undefined)?.value;
        if (v === "inFlight" || v === "cooldown") snap = undefined;
        _singleton = new WakeService(undefined, undefined, snap);
    }
    return _singleton;
}

export function resetWakeServiceForTests(): void {
    _singleton = new WakeService();
}

/** #1165 tests — null the singleton so the NEXT getWakeService() re-runs the
 *  pending-snapshot restore path (resetWakeServiceForTests installs a fresh
 *  instance and would bypass it). */
export function clearWakeServiceSingletonForTests(): void {
    _singleton = null;
}

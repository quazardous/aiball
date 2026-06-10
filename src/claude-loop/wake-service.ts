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
import { createActor, type ActorRefFrom } from "xstate";
import { wakeMachine } from "./wake-machine.js";

export class WakeService {
    private readonly actor: ActorRefFrom<typeof wakeMachine>;

    constructor(inFlightTtlMs?: number, coalesceWindowMs?: number) {
        this.actor = createActor(wakeMachine, {
            input: { inFlightTtlMs, coalesceWindowMs },
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
     *  have all settled (post-tryWakeInner). Transitions to `cooldown`. */
    completed(): void {
        this.actor.send({ type: "WAKE_COMPLETED" });
    }
}

let _singleton: WakeService | null = null;

export function getWakeService(): WakeService {
    if (!_singleton) _singleton = new WakeService();
    return _singleton;
}

export function resetWakeServiceForTests(): void {
    _singleton = new WakeService();
}

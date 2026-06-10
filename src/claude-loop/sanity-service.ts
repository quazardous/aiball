/**
 * SanityService — singleton façade over the `sanityMachine` XState v5 actor.
 *
 * Mirror du pattern Idle/Wake/Typing/Afk services. Composition root
 * dans `timer.ts:mainSse` :
 *   - busyW.on("change", visible) → sanity.busyLatched/busyCleared
 *   - wakeActor.on("wake:delivered", ...) → sanity.ticketActivity
 *   - hookWatcher.on("hook:user_prompt_submit", ...) → sanity.ticketActivity
 *   - sanityActor.on("sanity:clear_paneBusy", () => setPaneBusy(sd, false))
 *
 * See `docs/SM-NETWORK.md` (purity contract).
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { sanityMachine } from "./sanity-machine.js";
import { consumePendingSnapshot } from "./respawn-state.js";

export class SanityService {
    private readonly actor: ActorRefFrom<typeof sanityMachine>;

    constructor(staleMs?: number, snapshot?: Snapshot<unknown>) {
        this.actor = createActor(sanityMachine, { input: { staleMs }, snapshot });
        this.actor.start();
    }

    getActor(): ActorRefFrom<typeof sanityMachine> {
        return this.actor;
    }

    /** Push a BUSY_LATCHED event (= busyW saw `esc to interrupt` regex). */
    busyLatched(atMs: number = Date.now()): void {
        this.actor.send({ type: "BUSY_LATCHED", atMs });
    }

    /** Push a BUSY_CLEARED event (= path normal Stop hook + busyW false). */
    busyCleared(atMs: number = Date.now()): void {
        this.actor.send({ type: "BUSY_CLEARED", atMs });
    }

    /** Push a TICKET_ACTIVITY event (= signe de vie côté event flow). */
    ticketActivity(atMs: number = Date.now()): void {
        this.actor.send({ type: "TICKET_ACTIVITY", atMs });
    }
}

let _singleton: SanityService | null = null;

export function getSanityService(): SanityService {
    if (!_singleton) {
        // #884 respawn handoff : sanity n'est pas (encore) dans la
        // RespawnSnapshots map ; le consumePendingSnapshot retourne
        // undefined → cold start, état idle inferred au prochain
        // BUSY_LATCHED/CLEARED. Acceptable.
        const snap = consumePendingSnapshot("sanity" as never) as Snapshot<unknown> | undefined;
        _singleton = new SanityService(undefined, snap);
    }
    return _singleton;
}

export function resetSanityServiceForTests(): void {
    _singleton = new SanityService();
}

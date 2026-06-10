/**
 * AfkService — typed façade over the `afkMachine` XState v5 actor.
 *
 * Holds a single actor per instance and translates the public API
 * (`set10m`/`setInf`/`setOff` immediate ; `arm10m`/`armInf`/`armOff`
 * debounced via the machine's `after(debounce)` transitions) into
 * actor events. Reads expose the actor's context.
 *
 * The actor is the SOLE OWNER of the AFK lifecycle. `state.ts:toggleAfk`
 * goes through the debounced arm methods ; `afk-service-sync.ts`
 * `*ViaService` helpers go through the immediate set methods (proxy
 * events, boot-seal arm, etc.).
 *
 * See `docs/SM-NETWORK.md` for the network role and `afk-machine.ts`
 * for the state diagram.
 */
import { createActor, type ActorRefFrom } from "xstate";
import { afkMachine } from "./afk-machine.js";

export type AfkState = "off" | "wait_10m" | "wait_inf";

export interface AfkSnapshot {
    state: AfkState;
    expiryMs: number | null;
}

export class AfkService {
    private readonly actor: ActorRefFrom<typeof afkMachine>;
    private lastCommittedMode: AfkState = "off";
    private readonly subscribers: ((state: AfkState) => void)[] = [];

    constructor(initial: AfkState = "off", expiryMs: number | null = null, debounceMs?: number) {
        this.actor = createActor(afkMachine, { input: { debounceMs } });
        // Back-compat subscriber dispatcher on committed transitions
        // only (no fire on initial seed nor on pending intermediate
        // states). The ipcState bridge lives in `timer.ts:mainSse`
        // (composition root) — kept out of this class to avoid the
        // module-init coupling with `ipc-state.ts`.
        this.actor.subscribe((snap) => {
            const mode = snap.context.afkMode;
            if (mode !== this.lastCommittedMode) {
                this.lastCommittedMode = mode;
                for (const cb of this.subscribers) cb(mode);
            }
        });
        this.actor.start();
        // Apply initial state via HARD events (immediate, bypass debounce).
        if (initial === "wait_10m" && expiryMs !== null) {
            this.actor.send({ type: "HARD_ARM_10M", expiryMs });
        } else if (initial === "wait_inf") {
            this.actor.send({ type: "HARD_ARM_INF" });
        }
        // Reset lastCommittedMode tracker so the initial seed doesn't
        // count as a "transition" (= keep pre-XState contract of no
        // sub-fire on initial seed).
        this.lastCommittedMode = this.actor.getSnapshot().context.afkMode;
    }

    /** Current committed AFK mode (what consumers / wake gate read). */
    getState(): AfkState {
        return this.actor.getSnapshot().context.afkMode;
    }

    /** UNIX ms expiry for the wait_10m countdown ; null when off / wait_inf. */
    expiryMs(): number | null {
        return this.actor.getSnapshot().context.afkExpiryMs;
    }

    /** Convenience getter — `{ state, expiryMs }` in one read. */
    snapshot(): AfkSnapshot {
        const ctx = this.actor.getSnapshot().context;
        return { state: ctx.afkMode, expiryMs: ctx.afkExpiryMs };
    }

    /** Remaining countdown in ms (positive while running, 0 once expired,
     *  null when no countdown is active). */
    remainingMs(nowMs: number = Date.now()): number | null {
        const ctx = this.actor.getSnapshot().context;
        if (ctx.afkMode !== "wait_10m" || ctx.afkExpiryMs === null) return null;
        return Math.max(0, ctx.afkExpiryMs - nowMs);
    }

    /** Subscribe to COMMITTED state transitions. `cb` fires when afkMode
     *  flips (not on pending intermediate states, not on no-op re-arms,
     *  not on the initial seed). Matches the pre-XState Observable contract. */
    subscribe(cb: (state: AfkState) => void): () => void {
        this.subscribers.push(cb);
        return () => {
            const i = this.subscribers.indexOf(cb);
            if (i >= 0) this.subscribers.splice(i, 1);
        };
    }

    /** Direct access to the underlying actor — for the timer.ts subscriber
     *  that bridges actor.context to ipcState (both `afkMode` and
     *  `dispAfkMode`) and pumps EXPIRY_REACHED. */
    getActor(): ActorRefFrom<typeof afkMachine> {
        return this.actor;
    }

    // ─── Immediate ops (HARD_* events, bypass debounce) ───────────────────

    setOff(): void {
        this.actor.send({ type: "HARD_CLEAR" });
    }

    set10m(expiryMs: number): void {
        this.actor.send({ type: "HARD_ARM_10M", expiryMs });
    }

    setInf(): void {
        this.actor.send({ type: "HARD_ARM_INF" });
    }

    // ─── Debounced ops (ARM_* events, go through pending_X states) ────────

    arm10m(expiryMsHint: number): void {
        this.actor.send({ type: "ARM_10M", expiryMsHint });
    }

    armInf(): void {
        this.actor.send({ type: "ARM_INF" });
    }

    armOff(): void {
        this.actor.send({ type: "ARM_OFF" });
    }

    /** Pump the wait_10m expiry from the external setInterval wrapper. */
    expiryReached(): void {
        this.actor.send({ type: "EXPIRY_REACHED" });
    }
}

/** Per-process singleton (mirrors the BootMachine singleton pattern). */
let _singleton: AfkService | null = null;

export function getAfkService(): AfkService {
    if (!_singleton) _singleton = new AfkService();
    return _singleton;
}

export function resetAfkServiceForTests(): void {
    _singleton = new AfkService();
}

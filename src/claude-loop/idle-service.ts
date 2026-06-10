/**
 * IdleService — singleton façade over the `idleMachine` XState v5 actor.
 *
 * Mirrors the pattern of WakeService / AfkService / TypingService.
 * Composition root in `timer.ts:mainSse` wires the HookService events
 * (`SessionStart` / `Stop` / `UserPromptSubmit`) to the actor.
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { idleMachine } from "./idle-machine.js";
import { consumePendingSnapshot } from "./respawn-state.js";

export class IdleService {
    private readonly actor: ActorRefFrom<typeof idleMachine>;

    constructor(snapshot?: Snapshot<unknown>) {
        this.actor = createActor(idleMachine, { input: {}, snapshot });
        this.actor.start();
    }

    getActor(): ActorRefFrom<typeof idleMachine> {
        return this.actor;
    }

    sessionStart(atMs: number): void {
        this.actor.send({ type: "SESSION_START", atMs });
    }

    turnStarted(atMs: number): void {
        this.actor.send({ type: "TURN_STARTED", atMs });
    }

    turnEnded(atMs: number): void {
        this.actor.send({ type: "TURN_ENDED", atMs });
    }
}

let _singleton: IdleService | null = null;

export function getIdleService(): IdleService {
    if (!_singleton) {
        const snap = consumePendingSnapshot("idle") as Snapshot<unknown> | undefined;
        _singleton = new IdleService(snap);
    }
    return _singleton;
}

export function resetIdleServiceForTests(): void {
    _singleton = new IdleService();
}

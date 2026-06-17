/**
 * TurnService — singleton façade over the `turnMachine` XState v5 actor.
 *
 * Mirrors the pattern of WakeService / AfkService / TypingService.
 * Composition root in `timer.ts:mainSse` wires the HookService events
 * (`SessionStart` / `Stop` / `UserPromptSubmit`) to the actor.
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { turnMachine } from "./turn-machine.js";
import { consumePendingSnapshot } from "./respawn-state.js";

export class TurnService {
    private readonly actor: ActorRefFrom<typeof turnMachine>;

    constructor(snapshot?: Snapshot<unknown>) {
        this.actor = createActor(turnMachine, { input: {}, snapshot });
        this.actor.start();
    }

    getActor(): ActorRefFrom<typeof turnMachine> {
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

let _singleton: TurnService | null = null;

export function getTurnService(): TurnService {
    if (!_singleton) {
        // Snapshot map key stays "idle" — KEEP for respawn compat.
        const snap = consumePendingSnapshot("idle") as Snapshot<unknown> | undefined;
        _singleton = new TurnService(snap);
    }
    return _singleton;
}

export function resetTurnServiceForTests(): void {
    _singleton = new TurnService();
}

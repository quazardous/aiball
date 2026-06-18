/**
 * TurnService — singleton façade over the `turnMachine` XState v5 actor.
 *
 * Mirrors the pattern of WakeService / AfkService / TypingService.
 * Composition root in `timer.ts:mainSse` wires the HookService events
 * (`SessionStart` / `Stop` / `UserPromptSubmit`) to the actor.
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { turnMachine } from "./turn-machine.js";
import { WAKE_COOLDOWN_MS } from "./wake-machine.js";
import { CL_ENV } from "./env-vars.js";
import { consumePendingSnapshot } from "./respawn-state.js";

/** #999 — the drain tempo (turn:settled re-arm = `📨Ns`) is configurable via
 *  `claude_loop.wake_tempo_seconds` (env `CL_WAKE_TEMPO_SEC`, set by the loop
 *  process from its config). Falls back to the SSOT 10s when unset. */
function resolveTunnelMs(): number {
    const sec = Number(process.env[CL_ENV.WAKE_TEMPO_SEC]);
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : WAKE_COOLDOWN_MS;
}

export class TurnService {
    private readonly actor: ActorRefFrom<typeof turnMachine>;

    constructor(snapshot?: Snapshot<unknown>) {
        this.actor = createActor(turnMachine, {
            input: { tunnelMs: resolveTunnelMs() },
            snapshot,
        });
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

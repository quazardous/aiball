/**
 * HealthCheckService — singleton façade over `healthCheckMachine`.
 * Mirror du pattern Sanity / Idle / Wake / Typing / Afk services.
 *
 * Composition root dans `timer.ts:mainSse` :
 *   - healthCheckW.on("begin", ...) → health.promptDetected(atMs)
 *   - healthCheckW.on("end",   ...) → health.promptCleared(atMs)
 *   - healthActor.on("health:prompt_detected"/"cleared", log it)
 */
import { createActor, type ActorRefFrom, type Snapshot } from "xstate";
import { healthCheckMachine } from "./health-check-machine.js";
import { consumePendingSnapshot } from "./respawn-state.js";

export class HealthCheckService {
    private readonly actor: ActorRefFrom<typeof healthCheckMachine>;

    constructor(snapshot?: Snapshot<unknown>) {
        this.actor = createActor(healthCheckMachine, { snapshot });
        this.actor.start();
    }

    getActor(): ActorRefFrom<typeof healthCheckMachine> {
        return this.actor;
    }

    /** Push PROMPT_DETECTED (= native prompt visible in pane footer). */
    promptDetected(atMs: number = Date.now()): void {
        this.actor.send({ type: "PROMPT_DETECTED", atMs });
    }

    /** Push PROMPT_CLEARED (= native prompt no longer visible). */
    promptCleared(atMs: number = Date.now()): void {
        this.actor.send({ type: "PROMPT_CLEARED", atMs });
    }
}

let _singleton: HealthCheckService | null = null;

export function getHealthCheckService(): HealthCheckService {
    if (!_singleton) {
        // Respawn handoff (#884) : not in the snapshot map (yet) →
        // cold start at `idle`. Next pane scan re-arms if the prompt
        // is still visible.
        const snap = consumePendingSnapshot("healthCheck" as never) as Snapshot<unknown> | undefined;
        _singleton = new HealthCheckService(snap);
    }
    return _singleton;
}

export function resetHealthCheckServiceForTests(): void {
    _singleton = new HealthCheckService();
}

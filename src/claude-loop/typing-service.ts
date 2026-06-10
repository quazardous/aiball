/**
 * TypingService — singleton façade over the `typingMachine` XState v5 actor.
 *
 * Mirrors the pattern of WakeService / AfkService : a thin wrapper
 * exposing typed methods + a `getActor()` getter for `actor.on(...)`
 * consumers. The composition root in `timer.ts:mainSse` instantiates the
 * singleton and wires the ipcState bridge subscriber.
 */
import { createActor, type ActorRefFrom } from "xstate";
import { typingMachine } from "./typing-machine.js";

export class TypingService {
    private readonly actor: ActorRefFrom<typeof typingMachine>;

    constructor(ttlMs?: number) {
        this.actor = createActor(typingMachine, { input: { ttlMs } });
        this.actor.start();
    }

    getActor(): ActorRefFrom<typeof typingMachine> {
        return this.actor;
    }

    /** Push a KEYSTROKE event. The machine transitions `idle → hot` on
     *  first keystroke of a burst (emits `typing:started`) and resets
     *  the inactivity TTL on subsequent keystrokes (no re-emit). */
    keystroke(atMs: number = Date.now()): void {
        this.actor.send({ type: "KEYSTROKE", atMs });
    }

    /** Snapshot probe — `true` when the machine is in `hot` (= recent
     *  keystroke within ttlMs). Mirrors the legacy `isInputHot(input)`. */
    isHot(): boolean {
        return this.actor.getSnapshot().value === "hot";
    }
}

let _singleton: TypingService | null = null;

export function getTypingService(): TypingService {
    if (!_singleton) _singleton = new TypingService();
    return _singleton;
}

export function resetTypingServiceForTests(): void {
    _singleton = new TypingService();
}

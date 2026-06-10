/**
 * IdleMachine — XState v5 actor owning the claude busy/idle lifecycle.
 *
 * Minimal 3-state SM consuming the three Hook events that signal claude's
 * turn lifecycle :
 *   - `SESSION_START` → SessionStart hook (claude attaches to the pane)
 *   - `TURN_STARTED`  → UserPromptSubmit hook (claude starts a turn)
 *   - `TURN_ENDED`    → Stop hook (claude returned to the prompt)
 *
 * See `docs/SM-NETWORK.md` (purity contract + `<controller>:<event_name>`
 * convention).
 *
 * Model :
 *
 *   unknown ──SESSION_START──▶ idle.fresh ──after(WAKE_COOLDOWN_MS)──▶ idle.settled
 *                                 │                                        │
 *                                 │ TURN_STARTED              (emit idle:settled)
 *                                 ▼
 *                              busy ──TURN_ENDED──▶ idle.fresh
 *
 *   idle.settled = stable idle state. Consumers (timer.ts) écoutent
 *   `idle:settled` pour drainer la FIFO sans dépendre de SSE/heartbeat —
 *   #805 david : "si on est idle depuis plus de N secondes" → drain.
 *
 * #894 david `xt4w7v` : SSOT timing — le délai d'entrée dans `settled`
 * réutilise `WAKE_COOLDOWN_MS` (10s, le même tunnel qui rythme le wake
 * cooldown). Pas de param `settleMs` séparé (= 1 source de vérité par
 * concept "tunnel 10s post-état").
 *
 * Context :
 *   - `idleSinceMs` : timestamp of last entry to `idle` (null in busy/unknown)
 *
 * External pump : none. Pure event-driven from `HookService.subscribe(...)`
 * + XState's `after` delayed transition.
 */
import { setup, assign, emit } from "xstate";
import { WAKE_COOLDOWN_MS } from "./wake-machine.js";

export interface IdleMachineInput {
    /** Tests-only override — défaut prod = WAKE_COOLDOWN_MS (SSOT).
     *  Présent uniquement pour les fast tests (faire fire idle:settled
     *  en <1s au lieu d'attendre 10s du tunnel réel). */
    tunnelMs?: number;
}

/** Locus events emitted by the actor. */
export type IdleEmittedEvent =
    | { type: "idle:since"; atMs: number; reason: "session_start" | "turn_ended" }
    | { type: "idle:turn_started"; atMs: number }
    | { type: "idle:turn_ended"; atMs: number }
    | { type: "idle:settled"; idleSinceMs: number };

export const idleMachine = setup({
    types: {
        context: {} as {
            idleSinceMs: number | null;
            tunnelMs: number;
        },
        events: {} as
            | { type: "SESSION_START"; atMs: number }
            | { type: "TURN_STARTED"; atMs: number }
            | { type: "TURN_ENDED"; atMs: number },
        emitted: {} as IdleEmittedEvent,
        input: {} as IdleMachineInput,
    },
    delays: {
        tunnel: ({ context }) => context.tunnelMs,
    },
    actions: {
        stampIdleAt: assign({
            idleSinceMs: ({ event }) =>
                event.type === "SESSION_START" || event.type === "TURN_ENDED"
                    ? event.atMs
                    : null,
        }),
        clearIdle: assign({
            idleSinceMs: () => null,
        }),
        emitIdleSinceSessionStart: emit(({ event }) => ({
            type: "idle:since" as const,
            atMs: event.type === "SESSION_START" ? event.atMs : 0,
            reason: "session_start" as const,
        })),
        emitIdleSinceTurnEnded: emit(({ event }) => ({
            type: "idle:since" as const,
            atMs: event.type === "TURN_ENDED" ? event.atMs : 0,
            reason: "turn_ended" as const,
        })),
        emitTurnStarted: emit(({ event }) => ({
            type: "idle:turn_started" as const,
            atMs: event.type === "TURN_STARTED" ? event.atMs : 0,
        })),
        emitTurnEnded: emit(({ event }) => ({
            type: "idle:turn_ended" as const,
            atMs: event.type === "TURN_ENDED" ? event.atMs : 0,
        })),
        emitSettled: emit(({ context }) => ({
            type: "idle:settled" as const,
            idleSinceMs: context.idleSinceMs ?? 0,
        })),
    },
}).createMachine({
    id: "idle",
    initial: "unknown",
    context: ({ input }) => ({
        idleSinceMs: null,
        tunnelMs: input.tunnelMs ?? WAKE_COOLDOWN_MS,
    }),
    states: {
        unknown: {
            on: {
                SESSION_START: {
                    target: "idle",
                    actions: ["emitIdleSinceSessionStart", "stampIdleAt"],
                },
            },
        },
        idle: {
            initial: "fresh",
            on: {
                SESSION_START: {
                    target: ".fresh",
                    actions: ["emitIdleSinceSessionStart", "stampIdleAt"],
                },
                TURN_STARTED: {
                    target: "busy",
                    actions: ["emitTurnStarted", "clearIdle"],
                },
            },
            states: {
                fresh: {
                    after: {
                        tunnel: { target: "settled" },
                    },
                },
                settled: {
                    // Entry : 1er emit. Puis re-emit toutes les
                    // WAKE_COOLDOWN_MS tant qu'on reste dans settled —
                    // david `805` : sans ça, idle:settled fire 1 fois et
                    // le drain de la FIFO n'avance que sur les Stop hooks.
                    // Re-emit pour permettre N tryWake successifs sur 1
                    // longue idle.
                    entry: ["emitSettled"],
                    after: {
                        tunnel: { target: "settled", reenter: true },
                    },
                },
            },
        },
        busy: {
            on: {
                TURN_ENDED: {
                    target: "idle",
                    // Emit turn_ended BEFORE idle:since so consumers see
                    // the turn lifecycle event first, then the idle anchor.
                    actions: ["emitTurnEnded", "emitIdleSinceTurnEnded", "stampIdleAt"],
                },
                SESSION_START: {
                    // Rare : claude re-attached without a Stop. Treat
                    // as forced idle return.
                    target: "idle",
                    actions: ["emitIdleSinceSessionStart", "stampIdleAt"],
                },
            },
        },
    },
});

export type IdleMachine = typeof idleMachine;

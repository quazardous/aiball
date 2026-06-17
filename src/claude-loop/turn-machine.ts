/**
 * TurnMachine — XState v5 actor owning the claude turn lifecycle.
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
 *   unknown ──SESSION_START──▶ no_turn.fresh ──after(WAKE_COOLDOWN_MS)──▶ no_turn.settled
 *                                 │                                          │
 *                                 │ TURN_STARTED              (emit turn:settled)
 *                                 ▼
 *                              in_turn ──TURN_ENDED──▶ no_turn.fresh
 *
 *   no_turn.settled = stable no-turn state. Consumers (timer.ts) écoutent
 *   `turn:settled` pour drainer la FIFO sans dépendre de SSE/heartbeat —
 *   #805 david : "si on est idle depuis plus de N secondes" → drain.
 *
 * #894 david `xt4w7v` : SSOT timing — le délai d'entrée dans `settled`
 * réutilise `WAKE_COOLDOWN_MS` (10s, le même tunnel qui rythme le wake
 * cooldown). Pas de param `settleMs` séparé (= 1 source de vérité par
 * concept "tunnel 10s post-état").
 *
 * Context :
 *   - `idleSinceMs` : timestamp of last entry to `no_turn` (null in in_turn/unknown)
 *
 * External pump : none. Pure event-driven from `HookService.subscribe(...)`
 * + XState's `after` delayed transition.
 */
import { setup, assign, emit } from "xstate";
import { WAKE_COOLDOWN_MS } from "./wake-machine.js";

export interface TurnMachineInput {
    /** Tests-only override — défaut prod = WAKE_COOLDOWN_MS (SSOT).
     *  Présent uniquement pour les fast tests (faire fire turn:settled
     *  en <1s au lieu d'attendre 10s du tunnel réel). */
    tunnelMs?: number;
}

/** Locus events emitted by the actor. */
export type TurnEmittedEvent =
    | { type: "turn:no_turn_since"; atMs: number; reason: "session_start" | "turn_ended" }
    | { type: "turn:started"; atMs: number }
    | { type: "turn:ended"; atMs: number }
    | { type: "turn:settled"; idleSinceMs: number };

export const turnMachine = setup({
    types: {
        context: {} as {
            idleSinceMs: number | null;
            tunnelMs: number;
        },
        events: {} as
            | { type: "SESSION_START"; atMs: number }
            | { type: "TURN_STARTED"; atMs: number }
            | { type: "TURN_ENDED"; atMs: number },
        emitted: {} as TurnEmittedEvent,
        input: {} as TurnMachineInput,
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
        emitNoTurnSinceSessionStart: emit(({ event }) => ({
            type: "turn:no_turn_since" as const,
            atMs: event.type === "SESSION_START" ? event.atMs : 0,
            reason: "session_start" as const,
        })),
        emitNoTurnSinceTurnEnded: emit(({ event }) => ({
            type: "turn:no_turn_since" as const,
            atMs: event.type === "TURN_ENDED" ? event.atMs : 0,
            reason: "turn_ended" as const,
        })),
        emitTurnStarted: emit(({ event }) => ({
            type: "turn:started" as const,
            atMs: event.type === "TURN_STARTED" ? event.atMs : 0,
        })),
        emitTurnEnded: emit(({ event }) => ({
            type: "turn:ended" as const,
            atMs: event.type === "TURN_ENDED" ? event.atMs : 0,
        })),
        emitSettled: emit(({ context }) => ({
            type: "turn:settled" as const,
            idleSinceMs: context.idleSinceMs ?? 0,
        })),
    },
}).createMachine({
    id: "turn",
    initial: "unknown",
    context: ({ input }) => ({
        idleSinceMs: null,
        tunnelMs: input.tunnelMs ?? WAKE_COOLDOWN_MS,
    }),
    states: {
        unknown: {
            on: {
                SESSION_START: {
                    target: "no_turn",
                    actions: ["emitNoTurnSinceSessionStart", "stampIdleAt"],
                },
            },
        },
        no_turn: {
            initial: "fresh",
            on: {
                SESSION_START: {
                    target: ".fresh",
                    actions: ["emitNoTurnSinceSessionStart", "stampIdleAt"],
                },
                TURN_STARTED: {
                    target: "in_turn",
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
                    // david `805` : sans ça, turn:settled fire 1 fois et
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
        in_turn: {
            on: {
                TURN_ENDED: {
                    target: "no_turn",
                    // Emit turn:ended BEFORE turn:no_turn_since so consumers see
                    // the turn lifecycle event first, then the no-turn anchor.
                    actions: ["emitTurnEnded", "emitNoTurnSinceTurnEnded", "stampIdleAt"],
                },
                SESSION_START: {
                    // Rare : claude re-attached without a Stop. Treat
                    // as forced no-turn return.
                    target: "no_turn",
                    actions: ["emitNoTurnSinceSessionStart", "stampIdleAt"],
                },
                // #898 david `<chat>` : "le busy a survécu à 2 turns ...
                // phase busy orpheline qu'on sait plus éteindre". Si on
                // reçoit TURN_STARTED en in_turn, c'est que le turn précédent
                // n'a pas généré TURN_ENDED proprement (Stop hook perdu).
                // Self-heal : emit turn:ended (= turn:ended déclenche
                // les inline clears setPaneBusy(false) dans timer.ts), puis
                // reenter in_turn pour le nouveau turn.
                TURN_STARTED: {
                    target: "in_turn",
                    reenter: true,
                    actions: ["emitTurnEnded", "emitNoTurnSinceTurnEnded", "emitTurnStarted"],
                },
            },
        },
    },
});

export type TurnMachine = typeof turnMachine;

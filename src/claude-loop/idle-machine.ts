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
 *   unknown ──SESSION_START──▶ idle.fresh ──after(settleMs)──▶ idle.settled
 *                                 │                                │
 *                                 │ TURN_STARTED          (emit idle:settled)
 *                                 ▼
 *                              busy ──TURN_ENDED──▶ idle.fresh
 *
 *   idle.settled = stable idle state. Consumers (timer.ts) écoutent
 *   `idle:settled` pour drainer la FIFO sans dépendre de SSE/heartbeat —
 *   #805 david : "si on est idle depuis plus de N secondes" → drain.
 *
 * Context :
 *   - `idleSinceMs` : timestamp of last entry to `idle` (null in busy/unknown)
 *   - `settleMs`    : delay before emit idle:settled (default 30s)
 *
 * External pump : none. Pure event-driven from `HookService.subscribe(...)`
 * + XState's `after` delayed transition.
 */
import { setup, assign, emit } from "xstate";

export interface IdleMachineInput {
    /** Delay before emit `idle:settled`. Default 30s. */
    settleMs?: number;
}

/** Locus events emitted by the actor. */
export type IdleEmittedEvent =
    | { type: "idle:since"; atMs: number; reason: "session_start" | "turn_ended" }
    | { type: "idle:turn_started"; atMs: number }
    | { type: "idle:turn_ended"; atMs: number }
    | { type: "idle:settled"; idleSinceMs: number; settleMs: number };

const DEFAULT_SETTLE_MS = 30_000;

export const idleMachine = setup({
    types: {
        context: {} as {
            idleSinceMs: number | null;
            settleMs: number;
        },
        events: {} as
            | { type: "SESSION_START"; atMs: number }
            | { type: "TURN_STARTED"; atMs: number }
            | { type: "TURN_ENDED"; atMs: number },
        emitted: {} as IdleEmittedEvent,
        input: {} as IdleMachineInput,
    },
    delays: {
        settle: ({ context }) => context.settleMs,
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
            settleMs: context.settleMs,
        })),
    },
}).createMachine({
    id: "idle",
    initial: "unknown",
    context: ({ input }) => ({
        idleSinceMs: null,
        settleMs: input.settleMs ?? DEFAULT_SETTLE_MS,
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
                        settle: { target: "settled" },
                    },
                },
                settled: {
                    entry: ["emitSettled"],
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

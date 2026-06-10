/**
 * TypingMachine — XState v5 actor owning the human-typing signal.
 *
 * Minimal 2-state SM tracking a human keystroke timestamp with a TTL.
 * The `hot` state means "a keystroke landed within `ttlMs`". On entry
 * from `idle`, the machine emits `typing:started` once ; further
 * keystrokes refresh the TTL without re-emitting. The `after(ttlMs)`
 * exit returns to `idle` and emits `typing:ended`.
 *
 * See `docs/SM-NETWORK.md` for the `<controller>:<event_name>` convention
 * + the purity contract.
 *
 * Model :
 *
 *   idle ──KEYSTROKE(atMs)──▶ hot
 *    ▲    (emit typing:started)│
 *    │                         │ KEYSTROKE (reenter, refresh TTL, no emit)
 *    │                         │
 *    │   after(ttlMs)          │
 *    └─────────────────────────┘
 *        (emit typing:ended)
 *
 * Context :
 *   - `lastKeystrokeMs` : timestamp of the most recent KEYSTROKE event
 *     (null until first ever keystroke). Bridged to `ipc.humanTypingAtMs`
 *     by the subscriber in `timer.ts`.
 *   - `ttlMs` : how long after the last keystroke the SM stays hot.
 *
 * External pump : none — XState's internal `after(ttlMs)` handles
 * the idle return.
 */
import { setup, assign, emit } from "xstate";

export interface TypingMachineInput {
    /** Inactivity window before the SM returns to `idle`. Default 30s. */
    ttlMs?: number;
}

/** Locus events emitted by the actor. */
export type TypingEmittedEvent =
    | { type: "typing:started"; atMs: number }
    | { type: "typing:ended"; lastKeystrokeMs: number };

export const typingMachine = setup({
    types: {
        context: {} as {
            lastKeystrokeMs: number | null;
            ttlMs: number;
        },
        events: {} as { type: "KEYSTROKE"; atMs: number },
        emitted: {} as TypingEmittedEvent,
        input: {} as TypingMachineInput,
    },
    actions: {
        stampKeystroke: assign({
            lastKeystrokeMs: ({ event }) =>
                event.type === "KEYSTROKE" ? event.atMs : null,
        }),
        emitTypingStarted: emit(({ event }) => ({
            type: "typing:started" as const,
            atMs: event.type === "KEYSTROKE" ? event.atMs : 0,
        })),
        emitTypingEnded: emit(({ context }) => ({
            type: "typing:ended" as const,
            lastKeystrokeMs: context.lastKeystrokeMs ?? 0,
        })),
    },
    delays: {
        ttl: ({ context }) => context.ttlMs,
    },
}).createMachine({
    id: "typing",
    initial: "idle",
    context: ({ input }) => ({
        lastKeystrokeMs: null,
        ttlMs: input.ttlMs ?? 30_000,
    }),
    states: {
        idle: {
            on: {
                KEYSTROKE: {
                    target: "hot",
                    // emit BEFORE stamping so consumers see the fresh-start
                    // signal alongside the new timestamp in the same tick.
                    actions: ["emitTypingStarted", "stampKeystroke"],
                },
            },
        },
        hot: {
            after: {
                ttl: { target: "idle", actions: "emitTypingEnded" },
            },
            on: {
                // Reenter restarts the `after(ttl)` timer ; the stamp action
                // updates `lastKeystrokeMs`. No `emitTypingStarted` here —
                // the burst is one logical "started" event.
                KEYSTROKE: {
                    target: "hot",
                    reenter: true,
                    actions: "stampKeystroke",
                },
            },
        },
    },
});

export type TypingMachine = typeof typingMachine;

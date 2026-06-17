/**
 * SanityController — XState v5 actor owning the safety invariants of
 * the loop network. Slice A scope (#898) : un seul invariant — détecter
 * un `paneBusy=true` latch stale qui persiste après aucun signe d'activité.
 *
 * David `<chat>` :
 * > "si busy depuis plus de X minutes mais aucune activité dans les
 * >  ticket events on peut penser qu'on est stale"
 *
 * Modèle :
 *
 *   unknown ── BUSY_LATCHED ──▶ watching
 *                                  │
 *                                  │ TICKET_ACTIVITY → watching (reset clock)
 *                                  │ BUSY_CLEARED    → idle
 *                                  │ after(staleMs)  → emit sanity:clear_paneBusy
 *                                  ▼                   → idle
 *                                idle
 *                                  │ BUSY_LATCHED  → watching
 *
 * Watching → idle (cleared) si :
 *   - le path NORMAL (Stop hook → turn:ended → busyW.change=false)
 *     a propagé en aval (timer.ts subscriber send BUSY_CLEARED)
 *   - OU le délai stale expire = anormal, emit sanity:clear pour que le
 *     consumer corrige
 *
 * Cross-controller bridge (composition root timer.ts) :
 *   - busyW.on("change", visible) → sanityActor.send({BUSY_LATCHED|BUSY_CLEARED})
 *   - wakeActor.on("wake:delivered", ...) → TICKET_ACTIVITY (drain réussi)
 *   - hookWatcher.on("hook:user_prompt_submit") → TICKET_ACTIVITY (turn start)
 *   - sanityActor.on("sanity:clear_paneBusy", () => setPaneBusy(sd, false))
 *
 * Différence avec les inline clears `turn:ended` etc. dans timer.ts :
 * ceux-là gèrent le path NORMAL (Stop hook propre). Le SanityController
 * gère le path ANORMAL (Stop hook perdu / hook race / claude crash mid-
 * turn). 2 filets de sécurité complémentaires.
 *
 * Voir `docs/SM-NETWORK.md` (purity contract + `<controller>:<event_name>`
 * convention).
 */
import { setup, emit } from "xstate";

/** Default 5 min — bien plus long que n'importe quel turn busy claude
 *  normal. Tunable via env CL_STALE_BUSY_MS si besoin. */
export const STALE_BUSY_MS = 5 * 60 * 1000;

export interface SanityMachineInput {
    /** Test override — défaut prod STALE_BUSY_MS. */
    staleMs?: number;
}

/** Locus events emitted by the actor. */
export type SanityEmittedEvent =
    | { type: "sanity:clear_paneBusy"; reason: "stale_timeout"; atMs: number };

export const sanityMachine = setup({
    types: {
        context: {} as {
            staleMs: number;
        },
        events: {} as
            | { type: "BUSY_LATCHED"; atMs: number }
            | { type: "BUSY_CLEARED"; atMs: number }
            | { type: "TICKET_ACTIVITY"; atMs: number },
        emitted: {} as SanityEmittedEvent,
        input: {} as SanityMachineInput,
    },
    delays: {
        stale: ({ context }) => context.staleMs,
    },
    actions: {
        emitClearStale: emit(({ event }) => ({
            type: "sanity:clear_paneBusy" as const,
            reason: "stale_timeout" as const,
            atMs: "atMs" in event ? event.atMs : 0,
        })),
    },
}).createMachine({
    id: "sanity",
    initial: "unknown",
    context: ({ input }) => ({
        staleMs: input.staleMs ?? STALE_BUSY_MS,
    }),
    states: {
        unknown: {
            on: {
                BUSY_LATCHED: { target: "watching" },
                BUSY_CLEARED: { target: "idle" },
            },
        },
        idle: {
            on: {
                BUSY_LATCHED: { target: "watching" },
            },
        },
        watching: {
            on: {
                BUSY_CLEARED: { target: "idle" },
                // TICKET_ACTIVITY reset le clock en re-targeting watching
                // avec reenter (XState v5 — re-entry clears+re-arms after()).
                TICKET_ACTIVITY: { target: "watching", reenter: true },
                BUSY_LATCHED: { target: "watching", reenter: true },
            },
            after: {
                stale: {
                    target: "idle",
                    actions: ["emitClearStale"],
                },
            },
        },
    },
});

export type SanityMachine = typeof sanityMachine;

/**
 * WakeMachine — XState v5 actor owning the wake lifecycle.
 *
 * Replaces the `tryWakeInFlight` Promise mutex and centralizes the
 * post-fire cooldown in a dedicated state. External gates (zen,
 * idle-since, wakeAllowed, checkHasWork, drained-state, hasContent) stay
 * where they are — consumers compute them and decide whether to call
 * `REQUEST_WAKE`. The machine only owns the LIFECYCLE.
 *
 * See `docs/SM-NETWORK.md` for the `<controller>:<event_name>` convention
 * + payload guidelines.
 *
 * Model :
 *
 *   gated ──BOOT_READY──▶ idle ──REQUEST_WAKE──▶ inFlight ──...──▶ cooldown
 *                          ▲                                          │
 *                          │            after(coalesceWindowMs)        │
 *                          └────────────────────────────────────────────┘
 *
 * #848 david `<chat>` : initial state = `gated`. Aucun wake ne fire
 * tant que `BOOT_READY` (= bootMachine `loop:start`) n'est pas reçu.
 * REQUEST_WAKE pendant gated = emit cleared(reason="boot_gated").
 *
 *   `WAKE_DELIVERED` in `inFlight` emits `wake:delivered` without
 *   transitioning — the inject callback has hit send-keys but we stay
 *   in-flight until Stop hook or TTL.
 *
 * Context :
 *   - `wakeInFlightAtMs` : timestamp the actor entered inFlight (null when idle/cooldown)
 *   - `lastWakeAtMs`     : timestamp of the last `wake:delivered` (null until first)
 *   - `inFlightTtlMs`    : safety net delay for `inFlight → cooldown`
 *   - `coalesceWindowMs` : `cooldown → idle` delay
 *
 * External pump responsibility :
 *   - None for the lifecycle — XState `after()` handles both TTL + cooldown.
 *   - Consumers (`tryWake` in timer.ts) read `actor.getSnapshot().value === "idle"`
 *     to gate the next wake.
 */
import { setup, assign, emit } from "xstate";

/** #894 david `xt4w7v` — SSOT pour le 10s "tunnel" qui rythme l'inter-
 *  wake. Aussi utilisé par TurnController pour le délai d'entrée dans
 *  l'état settled (= idle stable). Aligne sur les autres 10s de la
 *  network : `BootMachine.tunnelMs` post-module + `sealed → loop:start`. */
export const WAKE_COOLDOWN_MS = 10_000;

export interface WakeMachineInput {
    /** Safety net for `inFlight → cooldown`. Default 30s. */
    inFlightTtlMs?: number;
    /** Post-wake `cooldown → idle` window. Default = WAKE_COOLDOWN_MS. */
    coalesceWindowMs?: number;
}

/** Locus events emitted by the actor. */
export type WakeEmittedEvent =
    | { type: "wake:requested"; source: string; atMs: number }
    | { type: "wake:in_flight_started"; atMs: number }
    | { type: "wake:delivered"; phrase: string; headMessageId: number | null }
    | { type: "wake:cleared"; reason: "completed" | "ttl" | "skipped" | "boot_gated" }
    | { type: "wake:cooldown_expired" };

export const wakeMachine = setup({
    types: {
        context: {} as {
            wakeInFlightAtMs: number | null;
            lastWakeAtMs: number | null;
            inFlightTtlMs: number;
            coalesceWindowMs: number;
        },
        events: {} as
            | { type: "REQUEST_WAKE"; source: string; atMs: number }
            | { type: "WAKE_DELIVERED"; phrase: string; headMessageId: number | null; deliveredAtMs: number }
            | { type: "WAKE_COMPLETED" }
            | { type: "WAKE_SKIPPED" }
            | { type: "IN_FLIGHT_TTL_EXPIRED" }
            | { type: "BOOT_READY" },
        emitted: {} as WakeEmittedEvent,
        input: {} as WakeMachineInput,
    },
    actions: {
        stampInFlight: assign({
            wakeInFlightAtMs: ({ event }) =>
                event.type === "REQUEST_WAKE" ? event.atMs : null,
        }),
        stampDelivered: assign({
            lastWakeAtMs: ({ event }) =>
                event.type === "WAKE_DELIVERED" ? event.deliveredAtMs : null,
        }),
        clearInFlight: assign({
            wakeInFlightAtMs: () => null,
        }),
        emitRequested: emit(({ event }) => ({
            type: "wake:requested" as const,
            source: event.type === "REQUEST_WAKE" ? event.source : "unknown",
            atMs: event.type === "REQUEST_WAKE" ? event.atMs : 0,
        })),
        emitInFlightStarted: emit(({ event }) => ({
            type: "wake:in_flight_started" as const,
            atMs: event.type === "REQUEST_WAKE" ? event.atMs : 0,
        })),
        emitDelivered: emit(({ event }) => ({
            type: "wake:delivered" as const,
            phrase: event.type === "WAKE_DELIVERED" ? event.phrase : "",
            headMessageId: event.type === "WAKE_DELIVERED" ? event.headMessageId : null,
        })),
        emitClearedCompleted: emit(() => ({
            type: "wake:cleared" as const,
            reason: "completed" as const,
        })),
        emitClearedTtl: emit(() => ({
            type: "wake:cleared" as const,
            reason: "ttl" as const,
        })),
        emitClearedSkipped: emit(() => ({
            type: "wake:cleared" as const,
            reason: "skipped" as const,
        })),
        emitClearedBootGated: emit(() => ({
            type: "wake:cleared" as const,
            reason: "boot_gated" as const,
        })),
        emitCooldownExpired: emit(() => ({
            type: "wake:cooldown_expired" as const,
        })),
    },
    delays: {
        inFlightTtl: ({ context }) => context.inFlightTtlMs,
        coalesceWindow: ({ context }) => context.coalesceWindowMs,
    },
}).createMachine({
    id: "wake",
    initial: "gated",
    context: ({ input }) => ({
        wakeInFlightAtMs: null,
        lastWakeAtMs: null,
        inFlightTtlMs: input.inFlightTtlMs ?? 30_000,
        coalesceWindowMs: input.coalesceWindowMs ?? WAKE_COOLDOWN_MS,
    }),
    states: {
        // #848 david `<chat>` : initial state = aucun wake ne fire tant
        // que BOOT_READY n'est pas reçu (= bootMachine `loop:start`).
        gated: {
            on: {
                BOOT_READY: { target: "idle" },
                REQUEST_WAKE: {
                    // Emit cleared(boot_gated) pour observabilité — aucune
                    // transition d'état, on reste gated.
                    actions: ["emitClearedBootGated"],
                },
            },
        },
        idle: {
            on: {
                REQUEST_WAKE: {
                    target: "inFlight",
                    actions: ["emitRequested", "emitInFlightStarted", "stampInFlight"],
                },
            },
        },
        inFlight: {
            after: {
                inFlightTtl: {
                    target: "cooldown",
                    actions: ["emitClearedTtl", "clearInFlight"],
                },
            },
            on: {
                WAKE_DELIVERED: {
                    actions: ["emitDelivered", "stampDelivered"],
                    // Stay in inFlight — the delivered event is mid-flight ;
                    // completion is signalled separately by WAKE_COMPLETED.
                },
                WAKE_COMPLETED: {
                    target: "cooldown",
                    actions: ["emitClearedCompleted", "clearInFlight"],
                },
                WAKE_SKIPPED: {
                    // tryWakeInner skipped (gate refused : zen, no work,
                    // busy-defer, etc.). No actual delivery happened, so
                    // skip cooldown and return directly to idle — the
                    // next wake attempt can proceed immediately.
                    target: "idle",
                    actions: ["emitClearedSkipped", "clearInFlight"],
                },
                IN_FLIGHT_TTL_EXPIRED: {
                    target: "cooldown",
                    actions: ["emitClearedTtl", "clearInFlight"],
                },
            },
        },
        cooldown: {
            after: {
                coalesceWindow: {
                    target: "idle",
                    actions: "emitCooldownExpired",
                },
            },
            // REQUEST_WAKE during cooldown is dropped — the consumer reads
            // `snap.value !== "idle"` and skips. No explicit handler needed.
        },
    },
});

export type WakeMachine = typeof wakeMachine;

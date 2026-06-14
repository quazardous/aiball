/**
 * HealthCheckController — XState v5 actor tracking the visibility of
 * Claude Code's NATIVE session-health feedback prompt (#949).
 *
 * Two-state binary :
 *
 *   idle ── PROMPT_DETECTED ──▶ prompted
 *                                   │
 *                                   │ PROMPT_CLEARED → idle
 *                                   ▼
 *                                 idle
 *
 * Emits one event per transition. Consumers (timer.ts) log them via
 * `actor.on(...)`. The machine itself is pure — no I/O, no log, no
 * Date.now — per the SM purity contract (docs/SM-NETWORK.md).
 *
 * Foundation for downstream capture of the response digit. Today we
 * just track + log ; the digit capture can hook on top later.
 */
import { setup, emit } from "xstate";

export type HealthCheckEmittedEvent =
    | { type: "health:prompt_detected"; atMs: number }
    | { type: "health:prompt_cleared"; atMs: number };

export const healthCheckMachine = setup({
    types: {
        events: {} as
            | { type: "PROMPT_DETECTED"; atMs: number }
            | { type: "PROMPT_CLEARED"; atMs: number },
        emitted: {} as HealthCheckEmittedEvent,
    },
    actions: {
        emitDetected: emit(({ event }) => ({
            type: "health:prompt_detected" as const,
            atMs: "atMs" in event ? event.atMs : 0,
        })),
        emitCleared: emit(({ event }) => ({
            type: "health:prompt_cleared" as const,
            atMs: "atMs" in event ? event.atMs : 0,
        })),
    },
}).createMachine({
    id: "healthCheck",
    initial: "idle",
    states: {
        idle: {
            on: {
                PROMPT_DETECTED: {
                    target: "prompted",
                    actions: ["emitDetected"],
                },
            },
        },
        prompted: {
            on: {
                PROMPT_CLEARED: {
                    target: "idle",
                    actions: ["emitCleared"],
                },
            },
        },
    },
});

export type HealthCheckMachine = typeof healthCheckMachine;

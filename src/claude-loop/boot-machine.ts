/**
 * BootMachine — XState v5 actor owning the boot phase lifecycle.
 *
 * Sole authority for sealing the boot phase. Subscriber bridges
 * `actor.context.deadlineMs` and the `sealed` transition to ipcState
 * (see `timer.ts:mainSse`). See `docs/SM-NETWORK.md` for the network
 * role + bridge pattern.
 *
 * Model :
 *
 *   ┌─────────┐  WATCHER_TICK         ┌─────────┐
 *   │ booting │─────────────────────▶│ booting │   (self-transition, push deadline)
 *   │         │  HOOK_SEAL ────────────▶ sealed
 *   │         │  DEADLINE_REACHED ─────▶ sealed
 *   └─────────┘                       └─────────┘
 *
 * Context :
 *   - loopStartMs : boot start
 *   - bootMinMs   : initial floor (= deadlineMs initial)
 *   - deadlineMs  : current seal deadline (mutated by WATCHER_TICK)
 *
 * External actor responsible for :
 *   - Pumping `WATCHER_TICK` on each pane probe observing a "still
 *     booting" condition (paneReady=false / picker / compacting).
 *   - Pumping `DEADLINE_REACHED` when wall-clock passes `context.deadlineMs`.
 *   - Pumping `HOOK_SEAL` when SessionStart hook signals immediate
 *     seal (via UDS hook event).
 *
 * Snapshot reads :
 *   - `actor.getSnapshot().matches("sealed")` → bootComplete=true
 *   - `actor.getSnapshot().context.deadlineMs - Date.now()` → remaining (bar display)
 */
import { setup, assign } from "xstate";

export interface BootMachineInput {
    loopStartMs: number;
    bootMinMs: number;
    /** Push extension on each watcher tick. Default 10s = david's debounce window. */
    pushExtensionMs?: number;
}

export const bootMachine = setup({
    types: {
        context: {} as {
            loopStartMs: number;
            bootMinMs: number;
            pushExtensionMs: number;
            deadlineMs: number;
        },
        events: {} as
            | { type: "WATCHER_TICK"; nowMs?: number }
            | { type: "HOOK_SEAL" }
            | { type: "DEADLINE_REACHED" },
        input: {} as BootMachineInput,
    },
    actions: {
        pushDeadline: assign({
            deadlineMs: ({ context, event }) => {
                if (event.type !== "WATCHER_TICK") return context.deadlineMs;
                const now = event.nowMs ?? Date.now();
                const candidate = now + context.pushExtensionMs;
                return Math.max(context.deadlineMs, candidate);
            },
        }),
    },
}).createMachine({
    id: "boot",
    initial: "booting",
    context: ({ input }) => ({
        loopStartMs: input.loopStartMs,
        bootMinMs: input.bootMinMs,
        pushExtensionMs: input.pushExtensionMs ?? 10_000,
        deadlineMs: input.loopStartMs + input.bootMinMs,
    }),
    states: {
        booting: {
            on: {
                WATCHER_TICK: { actions: "pushDeadline" },
                HOOK_SEAL: { target: "sealed" },
                DEADLINE_REACHED: { target: "sealed" },
            },
        },
        sealed: { type: "final" },
    },
});

export type BootMachine = typeof bootMachine;

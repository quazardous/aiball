/**
 * AfkMachine — XState v5 actor owning the AFK lifecycle.
 *
 * Sole authority for the F9 cycle + typing-arm + timed expiry, with a
 * 3s debounce that splits the displayed mode (chip, instant feedback)
 * from the committed mode (consumers : wake gate, isAfkActive). Both
 * derive from the same actor snapshot via the subscriber in `timer.ts`
 * (see `docs/SM-NETWORK.md`).
 *
 * Model :
 *
 *   off ──ARM_10M──▶ pending_10m ──after(debounce)──▶ wait_10m
 *    ▲                  │                                 │
 *    │ ARM_OFF          │ ARM_INF                         │
 *    │                  ▼                                 │ ARM_INF
 *    └── pending_off    pending_inf ──after(debounce)──▶ wait_inf
 *        ▲ after(deb.)      ▲                             │
 *        │                  │                             │
 *        └─ ARM_OFF cycles ─┘─────────────────────────────┘
 *
 *   wait_10m ──EXPIRY_REACHED──▶ off
 *
 *   HARD_* events bypass the debounce (programmatic immediate commit,
 *   e.g. respawn handoff, proxy event, boot-seal arm).
 *
 * Context :
 *   - `afkMode` : committed AFK mode (what consumers read)
 *   - `afkExpiryMs` : committed wait_10m expiry (null otherwise)
 *   - `dispExpiryMs` : displayed expiry hint (= afkExpiryMs mirror when
 *      the cycle is heading back to the committed wait_10m, else the
 *      fresh `now + 10min` hint passed by the toggle wrapper)
 *   - `debounceMs` : F9 debounce window (default 3000)
 *
 * NOOP same-kind invariant : if the F9 cycle ends at the SAME mode as
 * the committed mode (e.g. wait_10m → ARM_INF → ARM_OFF → ARM_10M ends
 * back on wait_10m before debounce fires), the after(debounce) transition
 * picks the `preserveWait10mExpiry` branch via the `committedIsWait10m`
 * guard — `afkExpiryMs` stays untouched, the running timer continues.
 *
 * External pump responsibility (see `timer.ts:mainSse`) :
 *   - Pumps `EXPIRY_REACHED` when wall-clock crosses `afkExpiryMs` while
 *     in `wait_10m` (the machine has no `Date.now()` access — pure).
 *   - On respawn handoff, sends `HARD_ARM_10M(expiryMs)` / `HARD_ARM_INF`
 *     right after `actor.start()` to sync with the live ipcState.
 */
import { setup, assign } from "xstate";

export type AfkMode = "off" | "wait_10m" | "wait_inf";

export interface AfkMachineInput {
    /** Debounce window between an F9 toggle and the committed state flip. */
    debounceMs?: number;
}

export const afkMachine = setup({
    types: {
        context: {} as {
            afkMode: AfkMode;
            afkExpiryMs: number | null;
            dispExpiryMs: number | null;
            debounceMs: number;
        },
        events: {} as
            | { type: "ARM_10M"; expiryMsHint: number }
            | { type: "ARM_INF" }
            | { type: "ARM_OFF" }
            | { type: "HARD_ARM_10M"; expiryMs: number }
            | { type: "HARD_ARM_INF" }
            | { type: "HARD_CLEAR" }
            | { type: "EXPIRY_REACHED" },
        input: {} as AfkMachineInput,
    },
    actions: {
        setDispFromHint: assign({
            dispExpiryMs: ({ event }) =>
                event.type === "ARM_10M" ? event.expiryMsHint : null,
        }),
        clearDisp: assign({
            dispExpiryMs: () => null,
        }),
        // Committed transitions via debounce (after(debounceMs))
        commitToOff: assign({
            afkMode: () => "off" as AfkMode,
            afkExpiryMs: () => null,
            dispExpiryMs: () => null,
        }),
        commitToWaitInf: assign({
            afkMode: () => "wait_inf" as AfkMode,
            afkExpiryMs: () => null,
            dispExpiryMs: () => null,
        }),
        preserveWait10mExpiry: assign({
            afkMode: () => "wait_10m" as AfkMode,
            // afkExpiryMs intentionally not reassigned — keep running timer.
            dispExpiryMs: ({ context }) => context.afkExpiryMs,
        }),
        freshArmWait10m: assign({
            afkMode: () => "wait_10m" as AfkMode,
            afkExpiryMs: ({ context }) => context.dispExpiryMs,
        }),
        // HARD_* immediate transitions (bypass debounce)
        hardArmWait10m: assign({
            afkMode: () => "wait_10m" as AfkMode,
            afkExpiryMs: ({ event }) =>
                event.type === "HARD_ARM_10M" ? event.expiryMs : null,
            dispExpiryMs: ({ event }) =>
                event.type === "HARD_ARM_10M" ? event.expiryMs : null,
        }),
    },
    guards: {
        committedIsWait10m: ({ context }) => context.afkMode === "wait_10m",
    },
    delays: {
        debounce: ({ context }) => context.debounceMs,
    },
}).createMachine({
    id: "afk",
    initial: "off",
    context: ({ input }) => ({
        afkMode: "off",
        afkExpiryMs: null,
        dispExpiryMs: null,
        debounceMs: input.debounceMs ?? 3000,
    }),
    states: {
        off: {
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint" },
                ARM_INF: { target: "pending_inf" },
                ARM_OFF: { target: "off" }, // no-op
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m" },
                HARD_ARM_INF: { target: "wait_inf", actions: "commitToWaitInf" },
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
            },
        },
        pending_off: {
            after: {
                debounce: { target: "off", actions: "commitToOff" },
            },
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint" },
                ARM_INF: { target: "pending_inf", actions: "clearDisp" },
                ARM_OFF: { target: "pending_off", reenter: true }, // reset debounce timer
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m" },
                HARD_ARM_INF: { target: "wait_inf", actions: "commitToWaitInf" },
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
            },
        },
        pending_10m: {
            after: {
                debounce: [
                    {
                        target: "wait_10m",
                        guard: "committedIsWait10m",
                        actions: "preserveWait10mExpiry",
                    },
                    {
                        target: "wait_10m",
                        actions: "freshArmWait10m",
                    },
                ],
            },
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint", reenter: true },
                ARM_INF: { target: "pending_inf", actions: "clearDisp" },
                ARM_OFF: { target: "pending_off", actions: "clearDisp" },
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m" },
                HARD_ARM_INF: { target: "wait_inf", actions: "commitToWaitInf" },
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
            },
        },
        pending_inf: {
            after: {
                debounce: { target: "wait_inf", actions: "commitToWaitInf" },
            },
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint" },
                ARM_INF: { target: "pending_inf", reenter: true }, // reset debounce
                ARM_OFF: { target: "pending_off" },
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m" },
                HARD_ARM_INF: { target: "wait_inf", actions: "commitToWaitInf" },
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
            },
        },
        wait_10m: {
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint" },
                ARM_INF: { target: "pending_inf" },
                ARM_OFF: { target: "pending_off" },
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m", reenter: true },
                HARD_ARM_INF: { target: "wait_inf", actions: "commitToWaitInf" },
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
                EXPIRY_REACHED: { target: "off", actions: "commitToOff" },
            },
        },
        wait_inf: {
            on: {
                ARM_10M: { target: "pending_10m", actions: "setDispFromHint" },
                ARM_INF: { target: "wait_inf" }, // no-op cycle
                ARM_OFF: { target: "pending_off" },
                HARD_ARM_10M: { target: "wait_10m", actions: "hardArmWait10m" },
                HARD_ARM_INF: { target: "wait_inf" }, // no-op
                HARD_CLEAR: { target: "off", actions: "commitToOff" },
            },
        },
    },
});

export type AfkMachine = typeof afkMachine;

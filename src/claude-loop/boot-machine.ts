/**
 * BootMachine — XState v5 actor owning the boot phase lifecycle.
 *
 * Sole authority for sealing the boot phase. Subscriber bridges
 * `actor.context.deadlineMs` and the `sealed` transition to ipcState
 * (see `timer.ts:mainSse`). See `docs/SM-NETWORK.md` for the network
 * role + bridge pattern.
 *
 * Architecture #883 — boot = séquence linéaire de TRANSIENT MODULES
 * optionnels (resume_picker, resuming, compact_confirm, compacting, …).
 * Tant qu'au moins UN module est actif, un "push manager" externe
 * (dans timer.ts) repousse la deadline de +10s toutes les secondes.
 * Quand le DERNIER module s'arrête, le manager s'arrête ; la dernière
 * push a fixé la deadline 10s dans le futur → expire 10s plus tard
 * → DEADLINE_REACHED → seal.
 *
 * Model :
 *
 *   booting ──MODULE_STARTED──▶ booting (activeModules+)
 *   booting ──MODULE_ENDED───▶ booting (activeModules-)
 *   booting ──PUSH──────────▶ booting (deadline = max(deadline, nowMs+tunnel) si modules actifs)
 *   booting ──HOOK_SEAL──────▶ sealed (respawn handoff, immediate)
 *   booting ──DEADLINE_REACHED▶ sealed (deadline expirée par le pump)
 *   sealed = final (terminal)
 *
 * Context :
 *   - loopStartMs : boot start (input)
 *   - bootMinMs   : initial floor (deadline initiale = loopStartMs + bootMinMs)
 *   - tunnelMs    : post-module-end tunnel + push step (default 10s)
 *   - activeModules : Set des noms de modules transients actifs
 *   - deadlineMs  : current seal deadline (pumpée par PUSH)
 *
 * External responsibility (cf. timer.ts) :
 *   - Forward watchers begin/end → `MODULE_STARTED`/`MODULE_ENDED`
 *   - Push manager : setInterval(1000) qui envoie `PUSH` tant que
 *     `activeModules.size > 0`. Armed/disarmed via `subscribe()`.
 *   - Deadline pump : setInterval(1000) qui envoie `DEADLINE_REACHED`
 *     quand `Date.now() >= deadlineMs`.
 *   - `HOOK_SEAL` au respawn handoff.
 *
 * Si AUCUN module n'est jamais observé (cold clean) :
 *   - Push manager jamais armé → deadline reste = loopStartMs + bootMinMs.
 *   - Pump fire DEADLINE_REACHED au floor → seal naturellement à 30s.
 */
import { setup, assign, emit } from "xstate";

export interface BootMachineInput {
    loopStartMs: number;
    bootMinMs: number;
    /** Tunnel + push step. Default 10s. */
    tunnelMs?: number;
}

/** Locus events emitted by the actor. */
export type BootEmittedEvent =
    | { type: "boot:sealed"; loopStartMs: number; reason: "deadline" | "hook" };

export const bootMachine = setup({
    types: {
        context: {} as {
            loopStartMs: number;
            bootMinMs: number;
            tunnelMs: number;
            activeModules: Set<string>;
            deadlineMs: number;
        },
        events: {} as
            | { type: "MODULE_STARTED"; name: string }
            | { type: "MODULE_ENDED"; name: string }
            | { type: "PUSH"; nowMs: number }
            | { type: "HOOK_SEAL" }
            | { type: "DEADLINE_REACHED" },
        emitted: {} as BootEmittedEvent,
        input: {} as BootMachineInput,
    },
    actions: {
        onModuleStarted: assign({
            activeModules: ({ context, event }) => {
                if (event.type !== "MODULE_STARTED") return context.activeModules;
                const next = new Set(context.activeModules);
                next.add(event.name);
                return next;
            },
        }),
        onModuleEnded: assign({
            activeModules: ({ context, event }) => {
                if (event.type !== "MODULE_ENDED") return context.activeModules;
                const next = new Set(context.activeModules);
                next.delete(event.name);
                return next;
            },
        }),
        onPush: assign({
            deadlineMs: ({ context, event }) => {
                if (event.type !== "PUSH") return context.deadlineMs;
                // Push only when at least one module is active. No-op
                // otherwise (caller shouldn't fire PUSH when idle, but
                // be defensive — keeps the machine pure).
                if (context.activeModules.size === 0) return context.deadlineMs;
                return Math.max(context.deadlineMs, event.nowMs + context.tunnelMs);
            },
        }),
        emitBootSealedDeadline: emit(({ context }) => ({
            type: "boot:sealed" as const,
            loopStartMs: context.loopStartMs,
            reason: "deadline" as const,
        })),
        emitBootSealedHook: emit(({ context }) => ({
            type: "boot:sealed" as const,
            loopStartMs: context.loopStartMs,
            reason: "hook" as const,
        })),
    },
}).createMachine({
    id: "boot",
    initial: "booting",
    context: ({ input }) => ({
        loopStartMs: input.loopStartMs,
        bootMinMs: input.bootMinMs,
        tunnelMs: input.tunnelMs ?? 10_000,
        activeModules: new Set<string>(),
        deadlineMs: input.loopStartMs + input.bootMinMs,
    }),
    states: {
        booting: {
            on: {
                MODULE_STARTED: { actions: "onModuleStarted" },
                MODULE_ENDED: { actions: "onModuleEnded" },
                PUSH: { actions: "onPush" },
                HOOK_SEAL: { target: "sealed", actions: "emitBootSealedHook" },
                DEADLINE_REACHED: { target: "sealed", actions: "emitBootSealedDeadline" },
            },
        },
        sealed: { type: "final" },
    },
});

export type BootMachine = typeof bootMachine;

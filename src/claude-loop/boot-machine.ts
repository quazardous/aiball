/**
 * BootMachine — XState v5 actor owning the boot phase lifecycle.
 *
 * Sole authority for sealing the boot phase. Subscriber bridges
 * `actor.context.deadlineMs` and the `sealed` transition to ipcState
 * (see `timer.ts:mainSse`). See `docs/SM-NETWORK.md` for the network
 * role + bridge pattern.
 *
 * #1009 — LEVEL + DECAY model (remplace l'edge-based Set+push de #883).
 * david : « la state machine devrait maintenir une pile de modules ; chaque
 * module se signale avec une date + rémanence 10s, se re-signale pour
 * prolonger ; on s'en fout de l'ordre ; rémanence = max(modules[].remanence) ;
 * quand tous les modules sont tombés c'est la fin de boot ».
 *
 * Chaque écran transitoire de boot (`resume_picker`, `resume_mode`,
 * `resuming`, `compacting`, `compact_confirm`) **se re-signale à chaque tick**
 * tant qu'il est visible (`MODULE_SEEN`). On stocke `{lastSeen, remanence}` par
 * module. Un module « tombe » quand `now > lastSeen + remanence` (il a cessé de
 * se signaler). Boot reste ouvert tant qu'AU MOINS un module n'est pas tombé ;
 * il scelle quand TOUS sont tombés. Pas d'appairage begin/end → un signal raté
 * ne peut pas figer un module pour toujours (la classe de bug #994 resume_mode
 * devient structurellement impossible).
 *
 * Le **floor** n'est qu'un module SEED `boot` (rémanence = bootMinMs, signalé
 * une seule fois à l'init) : un cold boot n'a que le seed → scelle à
 * `loopStart + bootMinMs`. Les transitoires (rémanence 10s) l'étendent.
 *
 *   deadline = max over modules de (lastSeen + remanence)
 *   seal ⟺ now ≥ deadline ⟺ tous les modules tombés
 *
 * Model :
 *   booting ──MODULE_SEEN──▶ booting (upsert module, recompute deadline)
 *   booting ──HOOK_SEAL────▶ sealed (respawn handoff, immédiat)
 *   booting ──DEADLINE_REACHED▶ sealed (tous tombés, fired par le pump)
 *   sealed = final (fresh → settled après 10s → emit loop:start)
 *
 * External responsibility (cf. timer.ts) :
 *   - À chaque pane tick : pour chaque module boot visible, envoyer
 *     `MODULE_SEEN{name, nowMs, remanenceMs}`.
 *   - Deadline pump : setInterval(1000) qui envoie `DEADLINE_REACHED` quand
 *     `Date.now() >= deadlineMs`.
 *   - `HOOK_SEAL` au respawn handoff.
 */
import { setup, assign, emit } from "xstate";

/** The synthetic floor module : seeded once at init with remanence = bootMinMs. */
export const SEED_MODULE = "boot";
/** Default remanence for transient boot screens (re-signalled each tick). */
export const DEFAULT_REMANENCE_MS = 10_000;

export interface BootMachineInput {
    loopStartMs: number;
    /** The seed module's remanence — the boot floor (default via caller). */
    bootMinMs: number;
}

/** Locus events emitted by the actor. */
export type BootEmittedEvent =
    | { type: "boot:sealed"; loopStartMs: number; reason: "deadline" | "hook" }
    | { type: "loop:start"; loopStartMs: number };

interface ModuleSeen {
    lastSeenMs: number;
    remanenceMs: number;
}

// #1059 — `moduleSeen` is a plain Record (NOT a Map) so the boot snapshot
// round-trips through `respawn-state.ts`'s JSON serialize/restore. A Map would
// serialize to `{}` and rehydrate as a non-iterable plain object, crashing the
// restored boot actor (`seen is not iterable`) → kernel dead on every snapshot
// respawn (self-reload / reload). The `?? {}` guards also make a legacy `{}`
// snapshot (from a pre-#1059 kernel) restore cleanly as an empty Record.

/** deadline = the latest fall-time across all modules = max(lastSeen + remanence). */
export function computeBootDeadline(seen: Record<string, ModuleSeen>): number {
    let max = 0;
    for (const m of Object.values(seen ?? {})) {
        const fallsAt = m.lastSeenMs + m.remanenceMs;
        if (fallsAt > max) max = fallsAt;
    }
    return max;
}

/** Modules still within their remanence window at `nowMs` (= not yet fallen). */
export function liveBootModules(seen: Record<string, ModuleSeen>, nowMs: number): string[] {
    const out: string[] = [];
    for (const [name, m] of Object.entries(seen ?? {})) {
        if (nowMs <= m.lastSeenMs + m.remanenceMs) out.push(name);
    }
    return out;
}

export const bootMachine = setup({
    types: {
        context: {} as {
            loopStartMs: number;
            bootMinMs: number;
            moduleSeen: Record<string, ModuleSeen>;
            deadlineMs: number;
        },
        events: {} as
            | { type: "MODULE_SEEN"; name: string; nowMs: number; remanenceMs?: number }
            | { type: "HOOK_SEAL" }
            | { type: "DEADLINE_REACHED" },
        emitted: {} as BootEmittedEvent,
        input: {} as BootMachineInput,
    },
    actions: {
        // Upsert the module's (lastSeen, remanence) and recompute the deadline
        // in one assign (single map build — assign property fns see OLD context).
        onModuleSeen: assign(({ context, event }) => {
            if (event.type !== "MODULE_SEEN") return {};
            const next: Record<string, ModuleSeen> = {
                ...context.moduleSeen,
                [event.name]: {
                    lastSeenMs: event.nowMs,
                    remanenceMs: event.remanenceMs ?? DEFAULT_REMANENCE_MS,
                },
            };
            return { moduleSeen: next, deadlineMs: computeBootDeadline(next) };
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
        emitLoopStart: emit(({ context }) => ({
            type: "loop:start" as const,
            loopStartMs: context.loopStartMs,
        })),
    },
}).createMachine({
    id: "boot",
    initial: "booting",
    context: ({ input }) => {
        // Seed the floor module : signalled once, remanence = bootMinMs.
        const moduleSeen: Record<string, ModuleSeen> = {
            [SEED_MODULE]: { lastSeenMs: input.loopStartMs, remanenceMs: input.bootMinMs },
        };
        return {
            loopStartMs: input.loopStartMs,
            bootMinMs: input.bootMinMs,
            moduleSeen,
            deadlineMs: computeBootDeadline(moduleSeen),
        };
    },
    states: {
        booting: {
            on: {
                MODULE_SEEN: { actions: "onModuleSeen" },
                HOOK_SEAL: { target: "sealed", actions: "emitBootSealedHook" },
                DEADLINE_REACHED: { target: "sealed", actions: "emitBootSealedDeadline" },
            },
        },
        // #848 — 2 sous-états après seal.
        //  - `sealed.fresh` : viens de seal, fenêtre "boot end" (post-boot
        //    inject, etc.) — durée 10s.
        //  - `sealed.settled` : entrée → emit `loop:start` (green light).
        sealed: {
            initial: "fresh",
            states: {
                fresh: {
                    after: {
                        10_000: { target: "settled" },
                    },
                },
                settled: {
                    entry: ["emitLoopStart"],
                },
            },
        },
    },
});

export type BootMachine = typeof bootMachine;

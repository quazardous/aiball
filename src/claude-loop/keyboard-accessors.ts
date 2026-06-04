/**
 * #649 Slice 3 — accesseurs typés pour la surface input clavier.
 *
 * Greenfield wrappers, parallèle de `pane-service.ts` mais sans observable —
 * david `cuhqpb` : "les input c'est plus hétérogène que l'écran". Le clavier
 * est par nature sondé en lecture mtime à la demande (pas push-based) ; pas
 * besoin de wrapper observable.
 *
 * Le but est de :
 *   - normaliser les unités (ms partout, pas de mélange sec/ms qui force le
 *     consommateur à multiplier par 1000),
 *   - exposer des "ageMs" / "remainingMs" en plus des booléens, utile pour
 *     la bar (animer un countdown) et pour les logs de debug,
 *   - donner un accesseur lecture-seule à `pane-interrupted` (jusqu'ici
 *     seul `setInterrupted` existait, le bar lisait via `existsSync` direct).
 *
 * The legacy boolean helpers in state.ts (`humanIsTyping`) stay for
 * back-compat. These accessors are the API new integrations should
 * use.
 *
 * Lecture mtime via `safeMtimeMs` → never throws (file absent / unreadable
 * = Infinity age = "jamais touché récemment").
 */
import { existsSync, statSync } from "node:fs";
import {
    HUMAN_TYPING_TTL_SEC,
    humanTypingPath,
} from "./state.js";
import { getIpcState } from "./ipc-state.js";

/** Default human-typing TTL in milliseconds. Mirror of state.ts's
 *  HUMAN_TYPING_TTL_SEC, exposed here in ms for symmetry with the rest of
 *  the accessor API. */
export const HUMAN_TYPING_TTL_MS = HUMAN_TYPING_TTL_SEC * 1000;

/** Read a file's mtime as ms-since-epoch. Returns `Infinity` if the file
 *  doesn't exist or the stat call fails — i.e. "infinitely old", which
 *  makes "age > ttl" checks behave correctly without a separate present-
 *  vs-absent branch. */
function safeMtimeMs(p: string): number {
    try {
        if (!existsSync(p)) return -Infinity;
        return statSync(p).mtimeMs;
    } catch {
        return -Infinity;
    }
}

/** Age in ms since the `human-typing` marker was last touched. Returns
 *  `Infinity` if the file is absent (= never typed / typed long ago and
 *  the touch isn't preserved). Pure read, no I/O beyond stat. */
export function humanTypingAgeMs(sd: string, nowMs: number = Date.now()): number {
    const m = safeMtimeMs(humanTypingPath(sd));
    if (m === -Infinity) return Infinity;
    return Math.max(0, nowMs - m);
}

/** True iff the human typed within the last `ttlMs` (default
 *  HUMAN_TYPING_TTL_MS = 5s). Strict `<`, matching the existing
 *  `humanIsTyping` semantics. */
export function isHumanTypingRecent(
    sd: string,
    ttlMs: number = HUMAN_TYPING_TTL_MS,
    nowMs: number = Date.now(),
): boolean {
    return humanTypingAgeMs(sd, nowMs) < ttlMs;
}

/** True iff the pane currently displays "interrupted by user" (set by
 *  the pane probe via `setInterrupted`). Decorative only — does not
 *  gate wakes ; bar may render `[idle:interrupted]` on it.
 *  #733 V2 : `ipcState.paneInterrupted` is the sole source ; null = no
 *  signal yet (cold boot, subprocess view) → `false`. */
export function paneInterrupted(_sd: string): boolean {
    return getIpcState().paneInterrupted ?? false;
}

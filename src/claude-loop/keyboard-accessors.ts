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
 * Les helpers booléens historiques de state.ts (`userIsTakingOver`,
 * `humanIsTyping`, `humanPresent`) restent — back-compat. Ces accesseurs
 * sont la API que les nouvelles intégrations devraient utiliser.
 *
 * Lecture mtime via `safeMtimeMs` → never throws (file absent / unreadable
 * = Infinity age = "jamais touché récemment").
 */
import { existsSync, statSync } from "node:fs";
import {
    HUMAN_TYPING_TTL_SEC,
    humanTypingPath,
    paneInterruptedPath,
    userTookOverPath,
} from "./state.js";

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

/** Age in ms since the `user-took-over` marker was last touched. Same
 *  semantics as humanTypingAgeMs but on a different file ; the marker
 *  is refreshed on every UserPromptSubmit hook fire. */
export function userGraceAgeMs(sd: string, nowMs: number = Date.now()): number {
    const m = safeMtimeMs(userTookOverPath(sd));
    if (m === -Infinity) return Infinity;
    return Math.max(0, nowMs - m);
}

/** True iff the user-took-over marker is fresh within `graceMs`. Mirror
 *  of `userIsTakingOver(sd, graceSec)` but unit is ms — let the caller
 *  multiply once at the config-read boundary instead of every call site. */
export function userGraceActive(
    sd: string,
    graceMs: number,
    nowMs: number = Date.now(),
): boolean {
    return userGraceAgeMs(sd, nowMs) < graceMs;
}

/** Remaining ms in the user-grace window (graceMs minus age, clamped to 0).
 *  Returns 0 when the marker is absent or grace has elapsed — never
 *  negative. Useful for the bar's "user grace expires in Ns" countdown. */
export function userGraceRemainingMs(
    sd: string,
    graceMs: number,
    nowMs: number = Date.now(),
): number {
    const age = userGraceAgeMs(sd, nowMs);
    if (age === Infinity) return 0;
    return Math.max(0, graceMs - age);
}

/** True iff the pane currently displays "interrupted by user" (set by
 *  the pane probe via `setInterrupted`). Decorative only — does not
 *  gate wakes ; bar may render `[idle:interrupted]` on it. Lecture
 *  mtime ignorée — la présence du fichier suffit (le `setInterrupted`
 *  unlink quand l'état clear). */
export function paneInterrupted(sd: string): boolean {
    return existsSync(paneInterruptedPath(sd));
}

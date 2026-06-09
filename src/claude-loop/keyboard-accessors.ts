/**
 * #649 Slice 3 — accesseurs typés pour la surface input clavier.
 *
 * Greenfield wrappers, parallèle de `pane-service.ts` mais sans observable —
 * david `cuhqpb` : "les input c'est plus hétérogène que l'écran".
 *
 * #840 `4z59jt` — IPC seul. `humanTypingAgeMs` lit
 * `ipcState.humanTypingAtMs` ; plus de `safeMtimeMs(humanTypingPath)`.
 */
import { HUMAN_TYPING_TTL_SEC } from "./state.js";
import { getIpcState } from "./ipc-state.js";

/** Default human-typing TTL in milliseconds. */
export const HUMAN_TYPING_TTL_MS = HUMAN_TYPING_TTL_SEC * 1000;

/** Age in ms since the human-typing event last fired. Returns
 *  `Infinity` if no event landed yet (cold start, subprocess view). */
export function humanTypingAgeMs(_sd: string, nowMs: number = Date.now()): number {
    const ts = getIpcState().humanTypingAtMs;
    if (ts === null) return Infinity;
    return Math.max(0, nowMs - ts);
}

/** True iff the human typed within the last `ttlMs` (default
 *  HUMAN_TYPING_TTL_MS = 5s). */
export function isHumanTypingRecent(
    sd: string,
    ttlMs: number = HUMAN_TYPING_TTL_MS,
    nowMs: number = Date.now(),
): boolean {
    return humanTypingAgeMs(sd, nowMs) < ttlMs;
}

/** True iff the pane currently displays "interrupted by user" (set by
 *  the pane probe via `setInterrupted`). */
export function paneInterrupted(_sd: string): boolean {
    return getIpcState().paneInterrupted ?? false;
}

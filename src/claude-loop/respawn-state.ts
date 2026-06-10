/**
 * #884 — Respawn snapshot handoff.
 *
 * Au reload du timer (`selfReloadIfStale` sur SHA bump ou `cmdReload`
 * explicite), le NEW process démarre frais. Chaque SM controller (Boot,
 * Afk, Wake, Typing, Idle) doit reprendre son état EXACT pour éviter :
 *   - re-boot phase de 30s avec bar jaune
 *   - reset AFK 10m countdown
 *   - perte du wake in-flight / cooldown
 *   - oubli de l'idle-since (drain FIFO reparti à zéro)
 *
 * Mécanique : XState v5 expose nativement la persistance via
 * `actor.getPersistedSnapshot()` côté OLD + `createActor(machine,
 * { snapshot })` côté NEW. Pas de logique ad-hoc par controller, pas de
 * HARD_* events pour le sync respawn — juste un round-trip du snapshot.
 *
 * Pattern uniforme remplaçant la whitelist `bootComplete + afkMode +
 * afkExpiryMs` du #868 initial.
 *
 * Backend = env var `CL_RESPAWN_STATE` (JSON-serialized snapshots map).
 * Limites :
 *   - 32KB max (Linux ARG_MAX). Snapshots typiques ~500 bytes/controller
 *     × 5 controllers = ~2.5KB → marge large.
 *   - Visible via `/proc/<pid>/environ` (pas de secret).
 *   - Ephémère : meurt avec le child process.
 *
 * Si payload dépasse, basculer vers fichier swap dans `/tmp` sans
 * changer les callsites (= remplacer juste la backend ici).
 */

/** Map des snapshots persistés par controller name. Chaque entrée est
 *  le résultat de `actor.getPersistedSnapshot()` pour le controller
 *  correspondant — XState v5 garantit que c'est JSON-serializable. */
export interface RespawnSnapshots {
    boot?: unknown;
    afk?: unknown;
    wake?: unknown;
    typing?: unknown;
    idle?: unknown;
}

/** #868 legacy whitelist — KEPT during the #884 transition pour ne pas
 *  briser les call sites existants. Les Slices B+C+D migrent
 *  progressivement vers `RespawnSnapshots` ; ce type sera retiré quand
 *  tous les consumers seront passés au snapshot pattern. */
export interface RespawnState {
    bootComplete?: boolean;
    afkMode?: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs?: number | null;
}

/** #868 legacy — kept for transition. */
export function serializeRespawnState(state: RespawnState): string {
    return JSON.stringify(state);
}

/** #868 legacy — kept for transition. */
export function parseRespawnState(raw: string | undefined): RespawnState | null {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw) as RespawnState;
        if (typeof obj !== "object" || obj === null) return null;
        return obj;
    } catch {
        return null;
    }
}

/** Sérialise les snapshots en string transmissible via env var. */
export function serializeRespawnSnapshots(snapshots: RespawnSnapshots): string {
    return JSON.stringify(snapshots);
}

/** Désérialise le payload reçu via env var. Retourne null si vide /
 *  malformed (= NEW timer démarre frais comme un cold boot). */
export function parseRespawnSnapshots(raw: string | undefined): RespawnSnapshots | null {
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw) as RespawnSnapshots;
        if (typeof obj !== "object" || obj === null) return null;
        return obj;
    } catch {
        return null;
    }
}

/** Env var qui transporte le swap entre OLD et NEW process. */
export const RESPAWN_STATE_ENV_VAR = "CL_RESPAWN_STATE";

/** Build le dict env à passer à `spawn()` côté OLD timer. Si snapshots
 *  est vide (aucun controller à transférer), retourne baseEnv inchangé
 *  → le NEW timer démarre en cold boot normal. */
export function buildRespawnEnvFromSnapshots(
    snapshots: RespawnSnapshots,
    baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const hasContent = snapshots.boot !== undefined
        || snapshots.afk !== undefined
        || snapshots.wake !== undefined
        || snapshots.typing !== undefined
        || snapshots.idle !== undefined;
    if (!hasContent) return baseEnv;
    return { ...baseEnv, [RESPAWN_STATE_ENV_VAR]: serializeRespawnSnapshots(snapshots) };
}

/** #868 legacy — kept for transition. */
export function buildRespawnEnv(
    state: RespawnState,
    baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const hasContent = state.bootComplete === true
        || (state.afkMode != null && state.afkMode !== "off");
    if (!hasContent) return baseEnv;
    return { ...baseEnv, [RESPAWN_STATE_ENV_VAR]: serializeRespawnState(state) };
}

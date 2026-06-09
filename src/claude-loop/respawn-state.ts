/**
 * #868 — Respawn state handoff service.
 *
 * Quand le timer process se respawn (`selfReloadIfStale` sur SHA bump,
 * ou `cmdReload` explicite), le NEW process démarre frais : son
 * ipcState est in-memory donc tout est null. Le wake gate retomberait
 * en "no idle marker" + la bar repasserait yellow [boot] pour ~2-3min
 * pendant que la SM re-converge — moche puisque claude tourne déjà au
 * prompt.
 *
 * Cette couche pontille la frontière process via une **whitelist** des
 * fields ipcState qui DOIVENT survivre. David `h5sgdx` principe :
 * seul l'état qui ne se re-dérive pas des watchers transite (= les
 * watchers pane/typing/dispAfk re-stampent en quelques secondes).
 *
 *   - `bootComplete` — boot phase a déjà sealed une fois ; le NEW
 *     timer ne doit pas y retourner.
 *   - `afkMode` + `afkExpiryMs` — F9 NOT AFK 10m a un expiry absolu ;
 *     le countdown doit continuer où il en était (pas resetter à 10m).
 *
 * Backend initial = env var `CL_RESPAWN_STATE` (JSON-serialized).
 * Limites :
 *   - 32KB max (Linux ARG_MAX). Notre payload ~100 bytes → large marge.
 *   - Visible via `/proc/<pid>/environ` (pas de secret dedans, OK).
 *   - Ephémère : meurt avec le process child, pas de cleanup.
 *
 * Si le whitelist grossit, basculer vers un fichier swap dans `/tmp`
 * sans changer les call sites (= remplacer juste la backend ici).
 */

/** Whitelist : champs ipcState qui survivent à un respawn. */
export interface RespawnState {
    bootComplete?: boolean;
    afkMode?: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs?: number | null;
}

/** Sérialise l'état whitelist en string transmissible (env var aujourd'hui). */
export function serializeRespawnState(state: RespawnState): string {
    return JSON.stringify(state);
}

/** Désérialise un payload reçu via env var. Retourne null si vide/malformed. */
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

/** Nom canonique de l'env var transportant le swap. */
export const RESPAWN_STATE_ENV_VAR = "CL_RESPAWN_STATE";

/** Build le dict env à passer à `spawn()` côté old timer, en propageant
 *  `process.env` + en injectant le swap sérialisé. Retourne `process.env`
 *  inchangé si state est vide (= aucun field à transférer). */
export function buildRespawnEnv(
    state: RespawnState,
    baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const hasContent = state.bootComplete === true
        || (state.afkMode != null && state.afkMode !== "off");
    if (!hasContent) return baseEnv;
    return { ...baseEnv, [RESPAWN_STATE_ENV_VAR]: serializeRespawnState(state) };
}

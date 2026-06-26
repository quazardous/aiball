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

/**
 * #1059 — env var posée par cmdReload + respawnKernel : signale au NEW kernel
 * qu'il REPREND une session claude vivante (reload/self-reload/revive), pas un
 * démarrage frais. Sert à (a) ne PAS ré-injecter le bootstrap skill, et (b) si
 * le snapshot AFK a été perdu (revive sock morte), repartir en NOT-AFK-10min
 * (hold anti-surprise) au lieu de `off` (autonome). cmdStart ne la pose PAS.
 */
export const REATTACH_ENV_VAR = "CL_REATTACH";

// =============================================================================
// Slice C — pending snapshots stash pour les service factories.
// =============================================================================

/** Snapshots parsés à l'init du NEW timer (= au tout début de mainSse).
 *  Chaque `getXxxService()` factory consume son entrée via
 *  `consumePendingSnapshot(name)` lors de la première création de son
 *  singleton. Consume one-shot : la 2e lecture retourne undefined. */
let _pendingSnapshots: RespawnSnapshots | null = null;

/** Set par mainSse au boot avec le résultat de
 *  `parseRespawnSnapshots(process.env[RESPAWN_STATE_ENV_VAR])`.
 *  Appelé une fois, avant les premiers getXxxService(). */
export function setPendingRespawnSnapshots(snapshots: RespawnSnapshots | null): void {
    _pendingSnapshots = snapshots;
}

/** Consume one-shot le snapshot pour `name`. Returns undefined si rien
 *  en attente ou déjà consumed → la factory créera son actor en cold. */
export function consumePendingSnapshot(name: keyof RespawnSnapshots): unknown | undefined {
    if (!_pendingSnapshots) return undefined;
    const s = _pendingSnapshots[name];
    if (s === undefined) return undefined;
    delete _pendingSnapshots[name];
    return s;
}

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


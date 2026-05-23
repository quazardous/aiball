// #379 — service PUR centralisé de la "drained-strategy" : que faire quand il
// ne reste QUE des tickets ouverts hors du camp de l'agent (pings=0,
// actionable=0, open>0) ? Logique sans dépendance ni I/O (façon decision-gate.ts)
// → unit-testée sans DB ni timer. Les consommateurs (timer claude-loop,
// hook-stop autopoll) DÉLÈGUENT ici, aucune duplication.
//
// Spectre (david, du moins au plus bavard), syntaxe `kind[:PT…[/PT…]]` :
//   - `silent`            — rien (défaut, zéro régression).
//   - `once`              — un seul wake à la "vidange", puis silence jusqu'à ce
//                           que le paysage bouge (le hash change).
//   - `stale[:PT2H]`      — auto-mémo : wake quand le backlog stagne (aucune
//                           activité humaine depuis > seuil). Silence pendant le
//                           travail. Un wake par paysage devenu stale.
//   - `backoff[:PT10M[/PT1D]]` — persistent poli : 1er rappel à +base, puis
//                           intervalle ×2 à chaque fois (base, 2·base, 4·base…),
//                           plafonné au cap. Reset quand le paysage bouge.
//   - `persistent[:PT30M]`— wake à chaque tick éligible tant qu'open>0 (espacé
//                           d'au moins le param si fourni).
//
// Reset partagé : `hash ≠ prevHash` (le paysage a bougé) → backoff repart à
// l'étape 0, `once` se ré-arme. C'est le même primitif `landscape_hash` (#379)
// qui sert aussi de dédup set-aware côté actionable.

export type DrainedKind = "silent" | "once" | "stale" | "backoff" | "persistent";

export interface DrainedStrategy {
    kind: DrainedKind;
    /** stale: seuil de stagnation ; backoff: intervalle de base ; persistent:
     *  espacement mini. ms. Absent → défaut par stratégie au moment de décider. */
    paramMs?: number;
    /** backoff: plafond de l'intervalle. ms. */
    capMs?: number;
}

/** État persistant (marqueur `CL_STATE_DIR/drained-state`). */
export interface DrainedState {
    /** Dernier landscape_hash observé. */
    hash: string;
    /** Quand le paysage courant est apparu (ms epoch) — base du backoff. */
    armedAt: number;
    /** Dernier wake-drained émis (ms epoch), ou null si aucun pour ce hash. */
    wakeAt: number | null;
    /** Nombre de rappels backoff déjà émis pour ce paysage. */
    step: number;
}

// Défauts (david `zxbfz2`) — noms nus = ces valeurs, `:PT…` override.
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;   // PT2H
export const DEFAULT_BACKOFF_BASE_MS = 10 * 60 * 1000; // PT10M
export const DEFAULT_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000; // PT1D
// Garde-fou : 2^step plafonné (l'intervalle est de toute façon capé, mais on
// évite un step qui enfle indéfiniment dans le marqueur).
const MAX_BACKOFF_STEP = 30;

/**
 * Parseur ISO-8601 de durée, lenient : accepte `PT2H`, `PT10M`, `PT30M`,
 * `PT1D`/`P1D` (D toléré même après T — david écrit `PT1D` pour le cap), avec
 * jours/heures/minutes/secondes. Renvoie ms, ou null si rien d'exploitable.
 */
export function parseIsoDuration(spec: string): number | null {
    const m = /^p?t?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(spec.trim());
    if (!m) return null;
    const [, d, h, min, s] = m;
    if (!d && !h && !min && !s) return null;
    return (
        (Number(d ?? 0) * 86_400 +
            Number(h ?? 0) * 3_600 +
            Number(min ?? 0) * 60 +
            Number(s ?? 0)) * 1000
    );
}

/**
 * Parse une spec `claude_loop.drained_strategy` en {@link DrainedStrategy}.
 * Tolérant : un `kind` inconnu OU une durée illisible retombe sur `silent`
 * (sûr) plutôt que de planter la boucle. Casse-insensible sur le kind.
 */
export function parseDrainedStrategy(spec: string | null | undefined): DrainedStrategy {
    const raw = (spec ?? "").trim();
    if (!raw) return { kind: "silent" };
    const [kindRaw, ...rest] = raw.split(":");
    const kind = kindRaw.toLowerCase();
    const param = rest.join(":").trim(); // re-join au cas où (pas de `:` attendu dans PT…)
    switch (kind) {
        case "silent":
            return { kind: "silent" };
        case "once":
            return { kind: "once" };
        case "stale":
            return { kind: "stale", paramMs: param ? parseIsoDuration(param) ?? DEFAULT_STALE_MS : DEFAULT_STALE_MS };
        case "backoff": {
            // `backoff:PT10M` ou `backoff:PT10M/PT1D` (base/cap).
            const [baseStr, capStr] = param.split("/");
            const base = baseStr ? parseIsoDuration(baseStr) ?? DEFAULT_BACKOFF_BASE_MS : DEFAULT_BACKOFF_BASE_MS;
            const cap = capStr ? parseIsoDuration(capStr) ?? DEFAULT_BACKOFF_CAP_MS : DEFAULT_BACKOFF_CAP_MS;
            return { kind: "backoff", paramMs: base, capMs: cap };
        }
        case "persistent":
            return { kind: "persistent", paramMs: param ? parseIsoDuration(param) ?? 0 : 0 };
        default:
            return { kind: "silent" };
    }
}

export interface DrainedDecisionInput {
    strategy: DrainedStrategy;
    /** landscape_hash courant (vision agent). */
    hash: string;
    /** max(last_actor_at) des ouverts en ms epoch, ou null — pour `stale`. */
    lastActivityMs: number | null;
    /** horloge injectée (ms epoch). */
    now: number;
    /** état persistant précédent, ou null (1er passage). */
    prev: DrainedState | null;
}

export interface DrainedDecision {
    wake: boolean;
    /** état à persister (toujours, même sans wake — porte armedAt/hash). */
    next: DrainedState;
}

/**
 * Décide s'il faut émettre un wake de rappel pour un backlog drainé, et calcule
 * l'état suivant. PURE (horloge injectée). Le caller persiste `next` et, si
 * `wake`, déclenche le send-keys.
 *
 * Reset : quand `hash ≠ prev.hash`, le paysage a bougé → `armedAt=now`,
 * `wakeAt=null`, `step=0` (backoff repart, `once`/`stale` se ré-arment).
 */
export function decideDrainedWake(input: DrainedDecisionInput): DrainedDecision {
    const { strategy, hash, lastActivityMs, now, prev } = input;
    const changed = !prev || prev.hash !== hash;
    let armedAt = changed ? now : prev!.armedAt;
    let wakeAt = changed ? null : prev!.wakeAt;
    let step = changed ? 0 : prev!.step;
    let wake = false;

    switch (strategy.kind) {
        case "silent":
            break;
        case "once":
            // Un seul wake par paysage : à la vidange (wakeAt encore null).
            if (wakeAt === null) wake = true;
            break;
        case "stale": {
            const threshold = strategy.paramMs ?? DEFAULT_STALE_MS;
            const isStale = lastActivityMs !== null && now - lastActivityMs >= threshold;
            // Auto-mémo : fire quand stale ET pas encore fire pour ce paysage.
            if (isStale && wakeAt === null) wake = true;
            break;
        }
        case "backoff": {
            const base = strategy.paramMs ?? DEFAULT_BACKOFF_BASE_MS;
            const cap = strategy.capMs ?? DEFAULT_BACKOFF_CAP_MS;
            const interval = Math.min(base * Math.pow(2, Math.min(step, MAX_BACKOFF_STEP)), cap);
            // 1er rappel à armedAt+base ; ensuite wakeAt+interval (×2 par step).
            const reference = wakeAt ?? armedAt;
            if (now - reference >= interval) wake = true;
            break;
        }
        case "persistent": {
            const spacing = strategy.paramMs ?? 0;
            // 1er tick pour ce paysage (wakeAt null) → fire immédiat ; sinon
            // espacé d'au moins `spacing`. Null explicite (pas de sentinelle 0,
            // qui supposerait now ≫ spacing).
            if (wakeAt === null || now - wakeAt >= spacing) wake = true;
            break;
        }
    }

    if (wake) {
        wakeAt = now;
        if (strategy.kind === "backoff") step = Math.min(step + 1, MAX_BACKOFF_STEP);
    }
    return { wake, next: { hash, armedAt, wakeAt, step } };
}

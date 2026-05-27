/**
 * #502 — pure dérivation de la pastille up/down sur un node proxy à partir de
 * `last_used_at` (timestamp ISO bumpé côté daemon à chaque request authentifiée
 * par le node token — heartbeat 30s + traffic réel). Seuils :
 *
 *   - ≤ 90s        : "up"    — vert  ; le node bat (1 heartbeat ≈ 30s, marge ×3)
 *   - 90s..5min    : "stale" — ambre ; 1+ heartbeat raté
 *   - > 5min / null: "down"  — gris  ; le node ne bat plus (ou jamais battu)
 *
 * Pure / sans Vue ; testable unitairement.
 */

export type NodeLiveness = "up" | "stale" | "down";

export const NODE_LIVENESS_UP_MS = 90_000;
export const NODE_LIVENESS_STALE_MS = 5 * 60_000;

export function nodeLivenessStatus(lastUsedAt: string | null | undefined, now: Date = new Date()): NodeLiveness {
    if (!lastUsedAt) return "down";
    const t = Date.parse(lastUsedAt);
    if (!Number.isFinite(t)) return "down";
    const age = now.getTime() - t;
    if (age <= NODE_LIVENESS_UP_MS) return "up";
    if (age <= NODE_LIVENESS_STALE_MS) return "stale";
    return "down";
}

/** Étiquette humaine courte affichée à côté de la pastille. */
export function nodeLivenessLabel(status: NodeLiveness): string {
    if (status === "up") return "up";
    if (status === "stale") return "stale";
    return "down";
}

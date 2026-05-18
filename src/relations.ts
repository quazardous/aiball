/**
 * Typed inter-ticket relations (#B.123 phase B). Lifts the historical
 * `parent_ticket_id` single-FK model to an event-sourced N-N graph
 * with semantic kinds.
 *
 * - `relates_to` — soft cross-reference, no impact on workflow.
 * - `depends_on` — this ticket cannot proceed until the target closes.
 *   Drives `actionable_count` gating (the gated ticket is silenced for
 *   the autopoll while the bloqueur stays open).
 * - `blocks` — inverse of depends_on, posted from the bloqueur side.
 *   Kept for convenience; the daemon stores it as a symmetric pair
 *   with a depends_on on the other ticket.
 * - `duplicates` — this ticket is a duplicate of the target; the
 *   target is the canonical one. Often paired with a close.
 * - `ignored` — explicit "we considered linking these and chose not
 *   to". Useful to suppress false-positive `#B.NNN` auto-ref linkifies.
 *
 * Events are stored as `messages` rows with `kind = "ticket_relation"`
 * and `meta = { relation: { kind, target_ticket_id } }`. The current
 * relation set for a ticket is the replay of all such events filtered
 * by the latest mutation per (source, target, kind) tuple — see
 * `db/messages.ts::listTypedRelationsForTicket`.
 *
 * Frontend mirror: `frontend/src/lib/relations.ts` (must stay aligned —
 * neither side imports across the build boundary).
 */

export const RELATION_KINDS = [
    "relates_to",
    "depends_on",
    "blocks",
    "duplicates",
    "ignored",
] as const;
export type RelationKind = typeof RELATION_KINDS[number];

export function isRelationKind(s: string): s is RelationKind {
    return (RELATION_KINDS as readonly string[]).includes(s);
}

export interface TypedRelationMeta {
    kind: RelationKind;
    target_ticket_id: number;
}

/**
 * Inverse pairing: when a user posts `blocks` from A→B, semantically
 * that's the same as `depends_on` from B→A. We persist the original
 * direction as-is (don't auto-flip on insert) so the audit trail stays
 * faithful, but readers can normalize via this helper.
 *
 * `relates_to`, `duplicates`, `ignored` are symmetric — the inverse is
 * the same kind on the flipped pair.
 */
export function inverseRelationKind(k: RelationKind): RelationKind {
    if (k === "depends_on") return "blocks";
    if (k === "blocks") return "depends_on";
    return k;
}

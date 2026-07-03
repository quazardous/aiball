/**
 * Frontend mirror of `src/relations.ts` (#B.123 phase B). Same kinds,
 * same helpers — bundle layer cannot import from `src/`.
 */

export const RELATION_KINDS = [
    "relates_to",
    "depends_on",
    "blocks",
    "duplicates",
    "ignored",
    "child_of",
    "parent_of",
] as const;
export type RelationKind = typeof RELATION_KINDS[number];

export function isRelationKind(s: string): s is RelationKind {
    return (RELATION_KINDS as readonly string[]).includes(s);
}

/**
 * Structural lineage kinds (#271) — auto-written on sub-ticket creation,
 * rendered read-only (no kebab menu) and excluded from the manual
 * add-relation picker. Mirror of `LINEAGE_RELATION_KINDS` in src/.
 */
export const LINEAGE_RELATION_KINDS: readonly RelationKind[] = ["child_of", "parent_of"];
export function isLineageRelationKind(k: string): boolean {
    return (LINEAGE_RELATION_KINDS as readonly string[]).includes(k);
}

/**
 * Human-facing labels for the relation kinds. Used in chips and the
 * dropdown selector.
 */
export const RELATION_LABELS: Record<RelationKind, string> = {
    relates_to: "relates to",
    depends_on: "depends on",
    blocks: "blocks",
    duplicates: "duplicates",
    ignored: "ignored",
    child_of: "child of",
    parent_of: "parent of",
};


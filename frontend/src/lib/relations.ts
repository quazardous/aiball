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
] as const;
export type RelationKind = typeof RELATION_KINDS[number];

export function isRelationKind(s: string): s is RelationKind {
    return (RELATION_KINDS as readonly string[]).includes(s);
}

export interface TypedRelationMeta {
    kind: RelationKind;
    target_ticket_id: number;
}

export function inverseRelationKind(k: RelationKind): RelationKind {
    if (k === "depends_on") return "blocks";
    if (k === "blocks") return "depends_on";
    return k;
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
};

/**
 * Severity hint for PrimeVue Tag — neutral for soft references,
 * warning for workflow-blocking, danger for duplicates.
 */
export const RELATION_SEVERITY: Record<RelationKind, "info" | "warn" | "danger" | "secondary"> = {
    relates_to: "info",
    depends_on: "warn",
    blocks: "warn",
    duplicates: "danger",
    ignored: "secondary",
};

/**
 * The kinds the thread renders as a compact RELATION ROW rather than a comment
 * card, and the label each one needs.
 *
 * #2388 david — these two lists used to live apart: the kind list in
 * `threadItems.ts`, the labels inside `ThreadCommentsList.vue`. An event kind
 * added to the first and not the second (`dependency_closed`, then
 * `related_closed`) made the template read `.icon` off `undefined`, which
 * throws mid-render: Vue drops the list, and every comment of the thread
 * disappears — the thread looked empty while the API served it whole. One
 * module now owns both, `relationRowLabel` never returns undefined, and a test
 * holds the two in sync.
 */
export interface RelationRowLabel {
    icon: string;
    verbOne: string;
    verbMany: string;
}

export const RELATION_ROW_LABELS: Record<string, RelationRowLabel> = {
    ticket_sub_added: {
        icon: "pi pi-sitemap",
        verbOne: "added sub-ticket",
        verbMany: "added sub-tickets",
    },
    ticket_referenced: {
        icon: "pi pi-link",
        verbOne: "referenced from",
        verbMany: "referenced from",
    },
    ticket_relation: {
        icon: "pi pi-share-alt",
        verbOne: "linked to",
        verbMany: "linked to",
    },
    dependency_closed: {
        icon: "pi pi-flag",
        verbOne: "closed a ticket this one was waiting on",
        verbMany: "closed tickets this one was waiting on",
    },
    related_closed: {
        icon: "pi pi-link",
        verbOne: "closed a ticket linked to this one",
        verbMany: "closed tickets linked to this one",
    },
    dependency_rejected: {
        icon: "pi pi-flag",
        verbOne: "rejected a ticket this one was waiting on",
        verbMany: "rejected tickets this one was waiting on",
    },
};

/** The kinds that render as a relation row. Every one of them has a label. */
export const RELATION_ROW_KINDS: readonly string[] = Object.keys(RELATION_ROW_LABELS);

export function isRelationRowKind(kind: string): boolean {
    return kind in RELATION_ROW_LABELS;
}

/**
 * The label for a row, never undefined: an unknown kind reads as a bare link
 * rather than blanking the thread it appears in.
 */
export function relationRowLabel(kind: string): RelationRowLabel {
    return RELATION_ROW_LABELS[kind] ?? { icon: "pi pi-link", verbOne: "linked to", verbMany: "linked to" };
}

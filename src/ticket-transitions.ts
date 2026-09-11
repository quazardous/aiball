/**
 * #2308 — what each decision a ticket can carry DOES, as one table.
 *
 * A decision kind used to be spelled out wherever it mattered: its gate family
 * in decisions.ts, its replay in db/decision-gate.ts, where it may be posted in
 * messages.ts, its `then` verb in mcp/ticket-write.ts, what accepting it closes
 * in api/messages.ts, the priority bump in db/messages.ts. Every new kind had to
 * find each of them, and nothing said when one was missed. Each kind is now one
 * row here; those places read the row, a truth-table test pins what the rows
 * mean, and the matrix in docs/TICKET_LIFECYCLE.md is generated from them.
 *
 * ZERO imports on purpose: the daemon, the MCP server and the frontend (through
 * the `@shared` alias) all load this file.
 */

export const DECISION_KINDS = ["plan", "resolution", "wontfix", "escalation"] as const;
export type DecisionKind = typeof DECISION_KINDS[number];

/** Where a decision may be attached. */
export type DecisionHost = "comment_added" | "ticket_created";

/**
 * What a decision does to the ticket's gate while it sits at a status.
 * - `held_until_counterpart`: out of the proposer's pool until someone else
 *   acts — a plain comment from anyone but the proposer makes the proposal moot.
 * - `held`: out of the pool, and settled: a later comment does not lift it.
 * - `open`: no hold.
 */
export type GateEffect = "held_until_counterpart" | "held" | "open";

/** What accepting a decision does, beyond flipping its status. */
export type AcceptEffect = "go" | "unblock" | "close_resolved" | "close_unresolved";

export interface DecisionGesture {
    /** The MCP `then` verb that posts it. */
    readonly verb: string;
    /** A proposal to END the ticket, or a signal that WAITS on someone. */
    readonly family: "closing" | "waiting";
    readonly allowedOn: readonly DecisionHost[];
    readonly gate: { readonly pending: GateEffect; readonly accepted: GateEffect; readonly rejected: GateEffect };
    readonly onAccept: AcceptEffect;
    /** What posting it does right away. */
    readonly onPost: { readonly bumpPriority: boolean; readonly broadcast: boolean };
    /** One line for the lifecycle doc. */
    readonly meaning: string;
    /** The inbox row flag raised while it is pending. */
    readonly inboxFlag: string;
    /** Among several pending decisions, the one a row points at first (lower wins). */
    readonly attentionRank: number;
    /** How the thread labels it while pending, and how loud. */
    readonly pendingLabel: string;
    readonly pendingSeverity: "warn" | "danger";
    /** Whether the inbox row keeps a "latest rejected" badge for this kind. */
    readonly surfacesRejection: boolean;
    /** Whether closing the ticket accepts it while it is still pending. */
    readonly autoAcceptedOnClose: boolean;
    /** Whether it is listed among the proposals an agent waits on (arbitrage). */
    readonly listedAsMyPending: boolean;
}

export const DECISION_GESTURES = {
    plan: {
        verb: "plan",
        family: "waiting",
        allowedOn: ["comment_added", "ticket_created"],
        gate: { pending: "held_until_counterpart", accepted: "open", rejected: "open" },
        onAccept: "go",
        onPost: { bumpPriority: false, broadcast: false },
        meaning: "how the work will go, for the reporter to validate",
        inboxFlag: "pending_plan", attentionRank: 1, pendingLabel: "pending plan", pendingSeverity: "warn",
        surfacesRejection: true, autoAcceptedOnClose: false, listedAsMyPending: true,
    },
    resolution: {
        verb: "resolved",
        family: "closing",
        allowedOn: ["comment_added"],
        gate: { pending: "held_until_counterpart", accepted: "held", rejected: "open" },
        onAccept: "close_resolved",
        onPost: { bumpPriority: false, broadcast: false },
        meaning: "the work is done, close the ticket",
        inboxFlag: "pending_resolution", attentionRank: 2, pendingLabel: "pending resolution", pendingSeverity: "warn",
        surfacesRejection: true, autoAcceptedOnClose: true, listedAsMyPending: true,
    },
    wontfix: {
        verb: "wontfix",
        family: "closing",
        allowedOn: ["comment_added"],
        gate: { pending: "held_until_counterpart", accepted: "held", rejected: "open" },
        onAccept: "close_unresolved",
        onPost: { bumpPriority: false, broadcast: false },
        meaning: "close without doing it: junk, out of scope, not reproducible",
        inboxFlag: "pending_wontfix", attentionRank: 3, pendingLabel: "pending wontfix", pendingSeverity: "warn",
        surfacesRejection: false, autoAcceptedOnClose: false, listedAsMyPending: false,
    },
    escalation: {
        verb: "escalate",
        family: "waiting",
        allowedOn: ["comment_added"],
        gate: { pending: "held_until_counterpart", accepted: "open", rejected: "open" },
        onAccept: "unblock",
        onPost: { bumpPriority: true, broadcast: true },
        meaning: "a blocker only a human can lift",
        inboxFlag: "pending_escalation", attentionRank: 0, pendingLabel: "ESCALATED", pendingSeverity: "danger",
        surfacesRejection: false, autoAcceptedOnClose: false, listedAsMyPending: false,
    },
} as const satisfies Record<DecisionKind, DecisionGesture>;

function isKind(kind: string): kind is DecisionKind {
    return (DECISION_KINDS as readonly string[]).includes(kind);
}

/** The row of a kind, or null for anything that is not a decision kind. */
export function decisionGesture(kind: string | null | undefined): DecisionGesture | null {
    return kind && isKind(kind) ? DECISION_GESTURES[kind] : null;
}

/** The gate a decision imposes at a status; null when the kind or the status is unknown — it is then inert. */
export function gateEffect(kind: string | null | undefined, status: string | null | undefined): GateEffect | null {
    const row = decisionGesture(kind);
    if (!row || (status !== "pending" && status !== "accepted" && status !== "rejected")) return null;
    return row.gate[status];
}

export function kindsInFamily(family: DecisionGesture["family"]): DecisionKind[] {
    return DECISION_KINDS.filter((k) => DECISION_GESTURES[k].family === family);
}

export function kindsAllowedOn(host: DecisionHost): DecisionKind[] {
    return DECISION_KINDS.filter((k) => (DECISION_GESTURES[k].allowedOn as readonly string[]).includes(host));
}

export function isDecisionAllowedOn(kind: string, host: string): boolean {
    const row = decisionGesture(kind);
    return !!row && (row.allowedOn as readonly string[]).includes(host);
}

/** The kind a `then` verb posts, or null for a verb that is not a decision (close, reopen…). */
export function kindForVerb(verb: string | null | undefined): DecisionKind | null {
    return DECISION_KINDS.find((k) => DECISION_GESTURES[k].verb === verb) ?? null;
}

/** Whether a decision at this status makes the ticket resolved. */
export function resolvesTicket(kind: string | null | undefined, status: string | null | undefined): boolean {
    return status === "accepted" && decisionGesture(kind)?.onAccept === "close_resolved";
}

/** The kinds in the order an inbox row points at them when several are pending. */
export function kindsByAttention(): DecisionKind[] {
    return [...DECISION_KINDS].sort((a, b) => DECISION_GESTURES[a].attentionRank - DECISION_GESTURES[b].attentionRank);
}

/** The `then` verbs that post a decision on `host`, in table order. */
export function verbsAllowedOn(host: DecisionHost): string[] {
    return kindsAllowedOn(host).map((k) => DECISION_GESTURES[k].verb);
}

// --- The lifecycle doc's matrix, generated from the rows above -----------------

const GATE_TEXT: Record<GateEffect, string> = {
    held_until_counterpart: "out of the proposer's pool until someone else acts",
    held: "out of the pool, settled",
    open: "back in the pool",
};

const ACCEPT_TEXT: Record<AcceptEffect, string> = {
    go: "go: the proposer executes",
    unblock: "unblocked, the ticket stays open",
    close_resolved: "the ticket closes, resolved",
    close_unresolved: "the ticket closes, not resolved",
};

export const DECISION_MATRIX_START = "<!-- decision-matrix:start -->";
export const DECISION_MATRIX_END = "<!-- decision-matrix:end -->";

export function renderDecisionMatrix(): string {
    const lines = [
        "| `then:` | stored as | allowed on | meaning | while pending | accepted | rejected | when posted | accepted when the ticket closes | in the agent's pending list | inbox flag |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const kind of DECISION_KINDS) {
        const g = DECISION_GESTURES[kind];
        const posted = [
            g.onPost.bumpPriority ? "priority up one notch" : "",
            g.onPost.broadcast ? "broadcast to followers" : "",
        ].filter(Boolean).join(", ") || "—";
        lines.push(
            `| \`${g.verb}\` | \`${kind}\` | ${g.allowedOn.map((h) => `\`${h}\``).join(", ")} | ${g.meaning}`
            + ` | ${GATE_TEXT[g.gate.pending]} | ${ACCEPT_TEXT[g.onAccept]}; ${GATE_TEXT[g.gate.accepted]}`
            + ` | ${GATE_TEXT[g.gate.rejected]} | ${posted} | ${g.autoAcceptedOnClose ? "yes" : "no"}`
            + ` | ${g.listedAsMyPending ? "yes" : "no"} | \`${g.inboxFlag}\` |`,
        );
    }
    return lines.join("\n");
}

/** `doc` with the block between the matrix markers replaced by the current matrix. Throws when a marker is missing. */
export function withDecisionMatrix(doc: string): string {
    const start = doc.indexOf(DECISION_MATRIX_START);
    const end = doc.indexOf(DECISION_MATRIX_END);
    if (start < 0 || end < start) throw new Error("decision matrix markers not found");
    return `${doc.slice(0, start + DECISION_MATRIX_START.length)}\n${renderDecisionMatrix()}\n${doc.slice(end)}`;
}

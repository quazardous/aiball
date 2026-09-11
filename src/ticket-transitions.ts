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

export const DECISION_KINDS = ["plan", "resolution", "wontfix", "escalation", "wait"] as const;
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
    /** #2297 — whether it names another ticket it waits on (`wait_for`), which
     *  blocks the ticket while that one is open and accepts it when that one closes. */
    readonly waitsForTicket: boolean;
    /** #2297 — whether posting it keeps the author's hand (it holds the ticket and
     *  carries on) instead of handing the ticket back like the other decisions. */
    readonly keepsTheHand: boolean;
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
        surfacesRejection: true, autoAcceptedOnClose: false, listedAsMyPending: true, waitsForTicket: false, keepsTheHand: false,
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
        surfacesRejection: true, autoAcceptedOnClose: true, listedAsMyPending: true, waitsForTicket: false, keepsTheHand: false,
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
        surfacesRejection: false, autoAcceptedOnClose: false, listedAsMyPending: false, waitsForTicket: false, keepsTheHand: false,
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
        surfacesRejection: false, autoAcceptedOnClose: false, listedAsMyPending: false, waitsForTicket: false, keepsTheHand: false,
    },
    wait: {
        verb: "wait",
        family: "waiting",
        allowedOn: ["comment_added"],
        // The decision itself holds nothing: while pending, its target blocks the
        // ticket like a soft depends_on (db/wait-gate.ts).
        gate: { pending: "open", accepted: "open", rejected: "open" },
        onAccept: "unblock",
        onPost: { bumpPriority: false, broadcast: false },
        meaning: "waiting on another ticket (`wait_for`): blocked until it closes, which accepts the wait; a human lifts it by rejecting it",
        inboxFlag: "pending_wait", attentionRank: 4, pendingLabel: "waiting", pendingSeverity: "warn",
        surfacesRejection: false, autoAcceptedOnClose: false, listedAsMyPending: false, waitsForTicket: true, keepsTheHand: true,
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

// --- Replies that carry no decision ---------------------------------------------

/**
 * A reply nobody accepts or rejects. #2331 — every message says whether it hands
 * the ticket back: a decision does (its author waits), `then: continue` does not
 * (the author carries on, and the step is marked), and a comment with no `then`
 * says it with `handback: true` (a question, an answer awaited) or
 * `handback: false` (keeping the hand without marking a step).
 */
export interface ReplyGesture {
    /** How the author asks for it. */
    readonly asked: string;
    /** What the comment carries; null when nothing. */
    readonly stored: string | null;
    readonly meaning: string;
    /** Does posting it make the author the ticket's last actor? */
    readonly movesLastActor: boolean;
    /** While it is the ticket's last action, is its author still in the pool — never "waiting on them"? */
    readonly keepsAuthorInPool: boolean;
    /** Only the agent holding the ticket (its live claim or its assignment) may post it. */
    readonly holderOnly: boolean;
    /** Flagged in the inbox once nothing has followed it for `tickets.step_stale_hours`. */
    readonly flaggedWhenNothingFollows: boolean;
}

export const REPLY_GESTURES = {
    handback: {
        asked: "handback: true",
        stored: "meta.handback",
        meaning: "hands the ticket back: a question, an answer awaited",
        movesLastActor: true,
        keepsAuthorInPool: false,
        holderOnly: false,
        flaggedWhenNothingFollows: false,
    },
    keep: {
        asked: "handback: false",
        stored: "meta.handback",
        meaning: "keeps the hand and carries on, without marking a step",
        movesLastActor: true,
        keepsAuthorInPool: true,
        holderOnly: true,
        flaggedWhenNothingFollows: false,
    },
    continue: {
        asked: "then: continue",
        stored: "meta.step",
        meaning: "a step is done and the work goes on, nothing to validate",
        movesLastActor: true,
        keepsAuthorInPool: true,
        holderOnly: true,
        flaggedWhenNothingFollows: true,
    },
} as const satisfies Record<string, ReplyGesture>;

/** The `then` verb that posts a step. */
export const STEP_VERB = "continue";
/** How the thread marks a step. */
export const STEP_LABEL = "step";

/** Does this comment meta mark a step? Anything unparseable is not one. */
export function isStepMeta(meta: string | null | undefined): boolean {
    if (!meta) return false;
    try {
        return (JSON.parse(meta) as { step?: unknown } | null)?.step === true;
    } catch {
        return false;
    }
}

/** #2331 — the `handback` a message's meta carries, or null when it carries none. */
export function readHandback(meta: string | null | undefined): boolean | null {
    if (!meta) return null;
    try {
        const v = (JSON.parse(meta) as { handback?: unknown } | null)?.handback;
        return typeof v === "boolean" ? v : null;
    } catch {
        return null;
    }
}

/** #2297 — the kind of the decision a comment carries, or null. */
export function readDecisionKind(meta: string | null | undefined): string | null {
    if (!meta) return null;
    try {
        const k = (JSON.parse(meta) as { decision?: { kind?: unknown } }).decision?.kind;
        return typeof k === "string" ? k : null;
    } catch {
        return null;
    }
}

/**
 * #2331 — the handback a comment's `then` implies: every decision waits on
 * someone (true), a step keeps the hand (false). null when the comment has no
 * `then`: an agent must then say it explicitly.
 */
export function implicitHandback(decisionKind: string | null | undefined, step: boolean): boolean | null {
    const row = decisionGesture(decisionKind);
    // #2297 — every decision waits on someone, except one that keeps the hand (a wait).
    if (row) return !row.keepsTheHand;
    if (step) return false;
    return null;
}

/** #2331 — why a comment's handback is refused, or null when it may go through. */
export function handbackRefusal(h: {
    decisionKind: string | null | undefined;
    step: boolean;
    handback: boolean | undefined;
    /** Must a comment with no `then` carry a handback (an agent, rule on)? */
    required: boolean;
}): string | null {
    const implicit = implicitHandback(h.decisionKind, h.step);
    if (implicit !== null) {
        if (h.handback === undefined || h.handback === implicit) return null;
        const gesture = h.step ? "then: continue" : `then: ${decisionGesture(h.decisionKind)?.verb}`;
        return `handback: ${h.handback} contradicts ${gesture}, which ${implicit ? "hands the ticket back" : "keeps the hand"}. `
            + "Leave handback out, or change the then. Nothing was posted.";
    }
    if (h.handback !== undefined || !h.required) return null;
    return "a comment without then: needs one, or handback. A step you finished on a ticket you hold: then: continue. "
        + "A step to have validated: then: plan. Work done, or a ticket to drop or unblock: then: resolved / wontfix / escalate. "
        + "Otherwise say whether you hand the ticket back: handback: true (a question, you wait for an answer; the ticket leaves your queue) "
        + "or handback: false (you keep working on it; only on a ticket you hold). Nothing was posted.";
}

/**
 * #2331 — what filing a ticket implies, deduced from who files it (the caller
 * never sends it): the project's lead keeps it, and is reminded to attach a plan
 * when there is none; anyone else — another project's agent, or a human from the
 * board — hands it back.
 */
export function creationHandback(c: {
    creatorIsHuman: boolean;
    creatorLeadsProject: boolean;
    hasPlan: boolean;
}): { handback: boolean; warning: string | null } {
    if (!c.creatorIsHuman && c.creatorLeadsProject) {
        return {
            handback: false,
            warning: c.hasPlan
                ? null
                : "you filed this ticket on a project you lead without then: plan. If you already know how the work should go, "
                    + "attach then: plan so a human validates the approach before you start.",
        };
    }
    return { handback: true, warning: null };
}

/** Does this event make its author the ticket's last actor? Read from the table; a step does since #2326. */
export function movesLastActor(kind: string, meta: string | null | undefined): boolean {
    if (kind === "comment_added" && isStepMeta(meta)) return REPLY_GESTURES.continue.movesLastActor;
    return true;
}

/**
 * #2326 — as the ticket's last action, does this event keep its author in the
 * pool? A step does: "not done, I carry on" must not leave the ticket waiting on
 * someone, even right after the author's own question. #2331 — nor does a
 * comment posted with `handback: false`. Nothing else keeps its author.
 */
export function keepsAuthorInPool(kind: string, meta: string | null | undefined): boolean {
    if (kind !== "comment_added") return false;
    if (isStepMeta(meta)) return REPLY_GESTURES.continue.keepsAuthorInPool;
    // #2297 — so does a decision that keeps the hand (a wait).
    if (decisionGesture(readDecisionKind(meta))?.keepsTheHand) return true;
    return readHandback(meta) === false && REPLY_GESTURES.keep.keepsAuthorInPool;
}

/** What `stepRefusal` needs to know about the ticket. */
export interface StepHold {
    author: string;
    ticketStatus: string;
    assignee: string | null;
    claimant: string | null;
    /** Is the claim still inside the assign window? */
    claimLive: boolean;
}

/** Why `author` may not post a step on this ticket, or null when it may. */
export function stepRefusal(h: StepHold, gesture: string = "then: continue"): string | null {
    if (h.ticketStatus !== "approved") {
        return `${gesture} needs an approved ticket; this one is "${h.ticketStatus}". Nothing was posted.`;
    }
    if (h.assignee === h.author || (h.claimLive && h.claimant === h.author)) return null;
    const holder = h.assignee ?? (h.claimLive ? h.claimant : null);
    if (holder) {
        return `${gesture} is for the agent holding the ticket, and it is held by ${holder}. Post handback: true instead. Nothing was posted.`;
    }
    return `${gesture} is for the agent holding the ticket: claim it first (ticket_claim), then post again. Nothing was posted.`;
}

/**
 * A step nothing has followed for `staleHours`: the work it announced went quiet.
 * `stepIsLatest` says nobody has spoken on the thread since. 0 hours = never.
 */
export function isStepStalled(stepAt: string | null, stepIsLatest: boolean, nowMs: number, staleHours: number): boolean {
    if (!stepAt || !stepIsLatest || !(staleHours > 0)) return false;
    const t = Date.parse(stepAt);
    return !Number.isNaN(t) && nowMs - t >= staleHours * 3_600_000;
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
    return `${doc.slice(0, start + DECISION_MATRIX_START.length)}\n${renderDecisionMatrix()}\n\n${renderReplyGestureMatrix()}\n${doc.slice(end)}`;
}

/** The replies that carry no decision, as a table for the lifecycle doc. */
export function renderReplyGestureMatrix(): string {
    const yesNo = (b: boolean) => (b ? "yes" : "no");
    const lines = [
        "Every decision above hands the ticket back (its author waits). The replies below carry no decision, so nobody accepts or rejects them; a comment with no `then` must say which one it is:",
        "",
        "| reply | stored as | meaning | makes the author the last actor | keeps the ticket in the author's pool | only the agent holding the ticket | flagged when nothing follows |",
        "|---|---|---|---|---|---|---|",
    ];
    for (const g of Object.values(REPLY_GESTURES) as ReplyGesture[]) {
        lines.push(
            `| \`${g.asked}\` | ${g.stored ? `\`${g.stored}\`` : "—"} | ${g.meaning}`
            + ` | ${yesNo(g.movesLastActor)} | ${yesNo(g.keepsAuthorInPool)} | ${yesNo(g.holderOnly)} | ${yesNo(g.flaggedWhenNothingFollows)} |`,
        );
    }
    return lines.join("\n");
}

/**
 * Single source of truth for aiball's business enums.
 *
 * Keeps the typed string-literal unions and the runtime arrays in lock-
 * step via `as const` + indexed access — adding a new value happens in
 * one place and propagates everywhere through TypeScript narrowing.
 *
 * Lives in `src/` (not in `src/db/`) on purpose: these are domain
 * concepts, not DB rows. `db/connection.ts` re-exports the types so
 * existing call sites keep compiling without touching imports.
 *
 * Frontend mirror: `frontend/src/lib/domain.ts` re-exports this module via
 * the `@shared` alias (vite + tsconfig paths), so there is ONE source — no
 * hand-kept copy to drift.
 */

import { DECISION_KINDS, type DecisionKind } from "./decisions.js";

// Base (non-decision) message kinds — explicit literals.
const BASE_MESSAGE_KINDS = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
    "ticket_reopened",
    "ticket_resolved",
    "ticket_blocked",
    // #2379 david `prrg57` — a claim whose protection had lapsed was taken over
    // by another agent. The take-over is legitimate (a forgotten claim must not
    // freeze a ticket), but it was silent: the holder lost the ticket without
    // being told and the thread kept no trace. Structural, like the events
    // below: not user-postable, and it does not move whose turn it is.
    "claim_taken_over",
    "ticket_sub_added",
    "ticket_referenced",
    // #2297 — posted by the daemon on each open ticket that was waiting on a
    // ticket (depends_on / blocks) when that ticket closes, so its watchers hear
    // the wait is over. Structural, like the two above: not user-postable, and it
    // does not move whose turn it is.
    "dependency_closed",
    // #2378 — posted by the daemon on each open ticket merely LINKED to a ticket
    // that closes (lineage or a cross-reference, not a gate): nothing changes for
    // it, but the close is news it would otherwise never hear.
    "related_closed",
    // #2388 — posted by the daemon on each open ticket that was waiting on a
    // ticket its moderator REJECTED. A rejection is not a close, so the gate
    // lifts in silence and the relation becomes a dead letter: this says so.
    "dependency_rejected",
    // #B.123 phase B: typed inter-ticket relation events
    // (relates_to / depends_on / blocks / duplicates / ignored stored
    // in meta.relation.kind). Lifecycle replay treats these as N-N graph
    // edges, NOT as comments — see src/relations.ts.
    "ticket_relation",
] as const;

// #830 david `a7pn65` — dedicated event kinds for the decision verbs
// (plan / resolution / wontfix / escalation) × the 2 terminal transitions
// (accepted / rejected). Replaces the previous "no dedicated event" path
// where the reporter's accept/reject only flipped meta.decision.status on
// the original comment, leaving the agent's wake injecting the unchanged
// proposal body with no verbal hint of the transition. Each event is
// inserted by the /decide handler AFTER applyDecision succeeds; meta
// carries `decision_ref: <original.hashid>` so the wake/UI can backlink.
//
// DERIVED from DECISION_KINDS (the single source): the set is exactly the
// cross-product `kind × {accepted, rejected}`, so a new decision verb needs
// no edit here — it flows in from decisions.ts. Type-level derivation via a
// template-literal type keeps the union exact; runtime array mirrors it.
export const DECISION_TRANSITIONS = ["accepted", "rejected"] as const;
export type DecisionTransition = typeof DECISION_TRANSITIONS[number];
export type DecisionEventKind = `${DecisionKind}_${DecisionTransition}`;
export const DECISION_EVENT_KINDS: readonly DecisionEventKind[] =
    DECISION_KINDS.flatMap((k) => DECISION_TRANSITIONS.map((t) => `${k}_${t}` as DecisionEventKind));
export function isDecisionEventKind(s: string): s is DecisionEventKind {
    return (DECISION_EVENT_KINDS as readonly string[]).includes(s);
}

export type MessageKind = typeof BASE_MESSAGE_KINDS[number] | DecisionEventKind;
export const MESSAGE_KINDS: readonly MessageKind[] = [...BASE_MESSAGE_KINDS, ...DECISION_EVENT_KINDS];

export const MESSAGE_STATUSES = ["pending", "approved", "rejected"] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

export const RULE_DECISIONS = ["auto", "review"] as const;
export type RuleDecision = typeof RULE_DECISIONS[number];

// #319: `feature` is a workflow-posture marker (not just a label) — a feature
// ticket is built isolated (branch + PR); `request` (default) & the rest are
// mainstream (edit `main` live, small always-green increments). The posture is
// a convention for whoever picks the ticket up; nothing in the code branches
// on it.
export const INTENTS = ["panic", "request", "question", "fyi", "feature"] as const;
export type Intent = typeof INTENTS[number];

/**
 * Per-ticket urgency hint (#B.222). Orthogonal to `intent` (the ticket's
 * nature). David framing (49dh42): "la priorité est juste à indiquer à
 * claude pour le moment via le mcp" — used by listMessages /
 * listPings (parent.priority secondary) / poll my_pending sorts so
 * claude tombe sur l'urgent en premier.
 *
 * `normal` is the migration backfill default; pick another only when
 * the ticket actually carries an urgency signal.
 */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = typeof PRIORITIES[number];
/** #2241 — a ticket's level: `task` (default: an ordinary ticket), `milestone`
 *  (a deliverable) or `roadmap` (a fuzzy, moving objective). Ordinal, bottom to
 *  top. Which levels an agent works on follows its type: LEVELS_BY_AGENT_TYPE. */
export const TICKET_LEVELS = ["task", "milestone", "roadmap"] as const;
export type TicketLevel = typeof TICKET_LEVELS[number];
/** #2241 — the levels each agent type works on: what enters its backlog, what
 *  notifies it, what it may claim. Same mechanism for every type, only the scope
 *  differs. Humans work on every level. */
export const LEVELS_BY_AGENT_TYPE = {
    coder: ["task"],
    cto: ["roadmap", "milestone"],
} as const satisfies Record<string, readonly TicketLevel[]>;

export const STRATEGIES = ["manual", "auto", "auto-reply"] as const;
export type Strategy = typeof STRATEGIES[number];

// #B.245 event scope tristate. `internal` = owners only + explicit @mentions;
// `default` = ticket subscribers + project owners + @mentions; `broadcast` =
// `default` + project followers. Default `default` (#253).
export const MESSAGE_SCOPES = ["internal", "default", "broadcast"] as const;
export type MessageScope = typeof MESSAGE_SCOPES[number];

// #582 — error codes thrown by submitMessage / api handlers and mapped to HTTP
// status by the API layer. Single source for both throw sites and catch sites.
// #3039 — and the `code` of every API refusal, `{ error, code, details? }`: the
// sentence is for a human, the code is the contract a client reacts on. A code,
// once shipped, keeps its meaning; a refusal nobody has made precise yet carries
// the generic code of its HTTP status (`errorCodeForStatus`).
export const ERROR_CODES = {
    // Generic, one per HTTP status: a refusal no client reacts on specifically.
    BAD_REQUEST: "BAD_REQUEST",
    UNAUTHORIZED: "UNAUTHORIZED",
    FORBIDDEN: "FORBIDDEN",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
    GONE: "GONE",
    PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
    TOO_MANY_REQUESTS: "TOO_MANY_REQUESTS",
    INTERNAL: "INTERNAL",
    NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
    BAD_GATEWAY: "BAD_GATEWAY",
    UNAVAILABLE: "UNAVAILABLE",
    /** #3039 — no token was sent (over TCP, or a key-only door). */
    AUTH_REQUIRED: "AUTH_REQUIRED",
    /** #3039 — the token or key sent is unknown, revoked or expired. */
    TOKEN_INVALID: "TOKEN_INVALID",
    /** #3039 — the key is valid but lacks the scope this door needs. */
    KEY_SCOPE_MISSING: "KEY_SCOPE_MISSING",
    /** #3039 — a gesture reserved to a registered human moderator. */
    MODERATOR_ONLY: "MODERATOR_ONLY",
    /** #3039 — the consumer (agent or human) named does not exist. */
    CONSUMER_NOT_FOUND: "CONSUMER_NOT_FOUND",
    /** #3039 — the message (comment or ticket event) named does not exist. */
    MESSAGE_NOT_FOUND: "MESSAGE_NOT_FOUND",
    /** #3039 — no running claude-loop answers for this agent. */
    LOOP_NOT_FOUND: "LOOP_NOT_FOUND",
    /** #3039 — a claim on a ticket assigned to someone else. */
    TICKET_ASSIGNED: "TICKET_ASSIGNED",
    /** #3039 — a claim on a ticket another agent holds, still protected. */
    TICKET_HELD: "TICKET_HELD",
    /** #3039 — deciding a proposal a newer decision on the ticket replaced. */
    DECISION_SUPERSEDED: "DECISION_SUPERSEDED",
    /** #3039 — approving or rejecting a message already moderated. */
    ALREADY_MODERATED: "ALREADY_MODERATED",
    /** #3039 — putting a ticket in a milestone that is already released. */
    MILESTONE_RELEASED: "MILESTONE_RELEASED",
    /** #3039 — putting a ticket in something that is not a milestone of its project. */
    MILESTONE_INVALID: "MILESTONE_INVALID",
    /** #3039 — an agent's comment without `then` and without `handback`. */
    HANDBACK_REQUIRED: "HANDBACK_REQUIRED",
    /** #3039 — a `handback` that contradicts the comment's `then`. */
    HANDBACK_CONTRADICTS: "HANDBACK_CONTRADICTS",
    /** #3039 — an agent's comment that does not say which commits it delivers. */
    COMMITS_REQUIRED: "COMMITS_REQUIRED",
    /** #3039 — `then: continue` without `resume_on`. */
    STEP_RESUME_REQUIRED: "STEP_RESUME_REQUIRED",
    /** #3039 — `resume_on.timer` above the project's maximum. */
    STEP_TIMER_TOO_LONG: "STEP_TIMER_TOO_LONG",
    /** #3039 — `resume_on.ticket` names no ticket, or this very one. */
    STEP_RESUME_INVALID: "STEP_RESUME_INVALID",
    CONFIG_OUT_OF_RANGE: "CONFIG_OUT_OF_RANGE",
    /** #3039 — a lineage relation that would close a cycle. */
    RELATION_CYCLE: "RELATION_CYCLE",
    /** #3039 — importing an upstream issue a ticket already mirrors (`existing_ticket_id`). */
    ALREADY_IMPORTED: "ALREADY_IMPORTED",
    /** #3066 — the agent's (or the name's) session runs elsewhere: claude-loop, or another host. */
    HOST_BUSY: "HOST_BUSY",
    /** #3066 — a handover waited for Claude to be idle, and it did not become so. */
    NOT_IDLE: "NOT_IDLE",
    /** #3036 — a body names an author other than the authenticated caller. */
    AUTHOR_MISMATCH: "AUTHOR_MISMATCH",
    /** #3037 — a tag named (or given by id) that does not exist. */
    TAG_UNKNOWN: "TAG_UNKNOWN",
    FORBIDDEN_CLOSE: "FORBIDDEN_CLOSE",
    PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
    PARENT_PENDING_MODERATION: "PARENT_PENDING_MODERATION",
    /** #2215 — a comment or lifecycle event aimed at a ticket that does not exist. */
    TICKET_NOT_FOUND: "TICKET_NOT_FOUND",
    /** #2308 — `then: continue` from an agent that does not hold the ticket. */
    STEP_NOT_HOLDER: "STEP_NOT_HOLDER",
    /** #2910 — releasing (closing) a milestone that still holds open tickets. */
    MILESTONE_HAS_OPEN: "MILESTONE_HAS_OPEN",
    /** #2910 — an agent writing on a ticket above the levels it works on. */
    LEVEL_READ_ONLY: "LEVEL_READ_ONLY",
} as const;
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

/** #3039 — the generic code of an HTTP status, for a refusal with no precise one. */
export function errorCodeForStatus(status: number): ErrorCode {
    switch (status) {
        case 400: return ERROR_CODES.BAD_REQUEST;
        case 401: return ERROR_CODES.UNAUTHORIZED;
        case 403: return ERROR_CODES.FORBIDDEN;
        case 404: return ERROR_CODES.NOT_FOUND;
        case 409: return ERROR_CODES.CONFLICT;
        case 410: return ERROR_CODES.GONE;
        case 413: return ERROR_CODES.PAYLOAD_TOO_LARGE;
        case 429: return ERROR_CODES.TOO_MANY_REQUESTS;
        case 501: return ERROR_CODES.NOT_IMPLEMENTED;
        case 502: return ERROR_CODES.BAD_GATEWAY;
        case 503: return ERROR_CODES.UNAVAILABLE;
        default: return status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.BAD_REQUEST;
    }
}

/** #3039 — whether a thrown error carries one of the codes above. */
export function isErrorCode(v: unknown): v is ErrorCode {
    return typeof v === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, v);
}

export function isMessageKind(s: string): s is MessageKind {
    return (MESSAGE_KINDS as readonly string[]).includes(s);
}
export function isMessageStatus(s: string): s is MessageStatus {
    return (MESSAGE_STATUSES as readonly string[]).includes(s);
}
export function isIntent(s: string): s is Intent {
    return (INTENTS as readonly string[]).includes(s);
}
export function isPriority(s: string): s is Priority {
    return (PRIORITIES as readonly string[]).includes(s);
}
export function isStrategy(s: string): s is Strategy {
    return (STRATEGIES as readonly string[]).includes(s);
}
export function isMessageScope(s: string): s is MessageScope {
    return (MESSAGE_SCOPES as readonly string[]).includes(s);
}

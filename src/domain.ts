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
 * Frontend mirror: `frontend/src/lib/domain.ts`. The two files MUST be
 * kept identical — the frontend bundle does not pull from `src/`, so
 * sharing a runtime module is impossible without a shared package.
 * Diverging here means UI / API drift.
 */

export const MESSAGE_KINDS = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
    "ticket_reopened",
    "ticket_resolved",
    "ticket_blocked",
    "ticket_sub_added",
    "ticket_referenced",
    // #B.123 phase B: typed inter-ticket relation events
    // (relates_to / depends_on / blocks / duplicates / ignored stored
    // in meta.relation.kind). Lifecycle replay treats these as N-N graph
    // edges, NOT as comments — see src/relations.ts.
    "ticket_relation",
] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];

export const MESSAGE_STATUSES = ["pending", "approved", "rejected"] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

export const RULE_DECISIONS = ["auto", "review"] as const;
export type RuleDecision = typeof RULE_DECISIONS[number];

// #319: `feature` is a workflow-posture marker (not just a label) — a feature
// ticket is built isolated (branch + PR); `request` (default) & the rest are
// mainstream (edit `main` live, small always-green increments). claude-loop
// surfaces a config-driven branch hint for `feature` tickets at wake time.
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

export const STRATEGIES = ["manual", "auto", "auto-reply"] as const;
export type Strategy = typeof STRATEGIES[number];

// #B.245 event scope tristate. `internal` = owners only + explicit @mentions;
// `default` = ticket subscribers + project owners + @mentions; `broadcast` =
// `default` + project followers. Default `default` (#253).
export const MESSAGE_SCOPES = ["internal", "default", "broadcast"] as const;
export type MessageScope = typeof MESSAGE_SCOPES[number];

// #582 — error codes thrown by submitMessage / api handlers and mapped to HTTP
// status by the API layer. Single source for both throw sites and catch sites.
export const ERROR_CODES = {
    FORBIDDEN_CLOSE: "FORBIDDEN_CLOSE",
    PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
    PARENT_PENDING_MODERATION: "PARENT_PENDING_MODERATION",
} as const;
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

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

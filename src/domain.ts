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
] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];

export const MESSAGE_STATUSES = ["pending", "approved", "rejected"] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

export const RULE_DECISIONS = ["auto", "review"] as const;
export type RuleDecision = typeof RULE_DECISIONS[number];

export const INTENTS = ["panic", "request", "question", "fyi"] as const;
export type Intent = typeof INTENTS[number];

export const STRATEGIES = ["manual", "auto", "auto-reply"] as const;
export type Strategy = typeof STRATEGIES[number];

export function isMessageKind(s: string): s is MessageKind {
    return (MESSAGE_KINDS as readonly string[]).includes(s);
}
export function isMessageStatus(s: string): s is MessageStatus {
    return (MESSAGE_STATUSES as readonly string[]).includes(s);
}
export function isIntent(s: string): s is Intent {
    return (INTENTS as readonly string[]).includes(s);
}
export function isStrategy(s: string): s is Strategy {
    return (STRATEGIES as readonly string[]).includes(s);
}

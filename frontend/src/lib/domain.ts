/**
 * Frontend mirror of `src/domain.ts` (#B.122).
 *
 * Same enums, same types, same helpers — kept identical so the frontend
 * and the daemon agree on the business surface. The frontend bundle
 * does not import from `src/`, so duplication is mandatory until we
 * extract a shared `@aiball/domain` package.
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
    "ticket_relation",
] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];

export const MESSAGE_STATUSES = ["pending", "approved", "rejected"] as const;
export type MessageStatus = typeof MESSAGE_STATUSES[number];

export const INTENTS = ["panic", "request", "question", "fyi"] as const;
export type Intent = typeof INTENTS[number];

/**
 * Per-ticket urgency hint (#B.222) — orthogonal to `intent` (which is
 * the ticket's nature). Mirror of the backend enum in `src/domain.ts`.
 * `normal` is the schema default; pick another only when the ticket
 * actually carries an urgency signal.
 */
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = typeof PRIORITIES[number];

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
export function isPriority(s: string): s is Priority {
    return (PRIORITIES as readonly string[]).includes(s);
}
export function isStrategy(s: string): s is Strategy {
    return (STRATEGIES as readonly string[]).includes(s);
}

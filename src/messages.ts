import {
    getMessage,
    insertMessage,
    updateMessageStatus,
    insertPing,
    listTicketSubscribers,
    listProjectSubscribers,
    upsertTicketSubscription,
    PRIORITIES,
    type Message,
    type NewMessage,
    type MessageKind,
    type Priority,
} from "./db.js";
import { evaluate } from "./rules.js";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";

export const VALID_KINDS: MessageKind[] = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
    "ticket_reopened",
];

export interface ValidationError {
    error: string;
}

export function validateNewMessage(input: unknown): ValidationError | NewMessage {
    if (!input || typeof input !== "object") return { error: "body must be object" };
    const o = input as Record<string, unknown>;
    if (typeof o.project !== "string" || !o.project) {
        return { error: "project required" };
    }
    if (typeof o.kind !== "string" || !VALID_KINDS.includes(o.kind as MessageKind)) {
        return { error: `kind must be one of ${VALID_KINDS.join(", ")}` };
    }
    const kind = o.kind as MessageKind;
    if (kind !== "ticket_created") {
        if (typeof o.ticket_id !== "number" || !o.ticket_id) {
            return { error: `ticket_id required for kind=${kind}` };
        }
    }
    if (kind === "ticket_created" && (typeof o.title !== "string" || !o.title)) {
        return { error: "title required for ticket_created" };
    }
    let priority: Priority | null = null;
    if (o.priority !== undefined && o.priority !== null) {
        if (typeof o.priority !== "string" || !PRIORITIES.includes(o.priority as Priority)) {
            return { error: `priority must be one of ${PRIORITIES.join(", ")}` };
        }
        priority = o.priority as Priority;
    }
    return {
        project: o.project,
        kind,
        ticket_id: typeof o.ticket_id === "number" ? o.ticket_id : null,
        parent_id: typeof o.parent_id === "number" ? o.parent_id : null,
        title: typeof o.title === "string" ? o.title : null,
        body: typeof o.body === "string" ? o.body : null,
        by_agent: typeof o.by_agent === "string" ? o.by_agent : null,
        priority: kind === "ticket_created" ? priority : null,
    };
}

/**
 * Auto-subscribe the message author to its parent ticket. Called for every
 * inserted message regardless of moderation outcome — even if the message
 * itself is rejected later, the author has shown intent to follow the
 * thread. No-ops if by_agent is unset (anonymous post).
 */
function autoSubscribeAuthor(msg: Message): void {
    if (!msg.by_agent) return;
    const ticketId = msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (!ticketId) return;
    upsertTicketSubscription(msg.by_agent, ticketId);
}

/**
 * Fan out delivery rows (in the `pings` table) for every recipient that
 * should learn about this newly-approved message. Recipients are the union
 * of:
 *   - ticket subscribers (people following the thread directly)
 *   - project subscribers (people following the whole project)
 * minus the message author themself (no self-ping).
 *
 * Each ping row is per-recipient with its own `seen_at`, so consumption is
 * independent across consumers. Called only when a message becomes approved.
 *
 * This is the SOLE delivery mechanism — there is no cursor model anywhere.
 * Pending-then-approved messages always reach every interested consumer
 * because the fan-out runs at approval time, not at submission.
 */
export function fanOutPings(msg: Message): void {
    const recipients = new Set<string>();
    // Ticket subscribers, except for ticket_created (no thread yet, the
    // creator is auto-subbed to themselves and would be filtered as self).
    if (msg.kind !== "ticket_created" && msg.ticket_id !== null) {
        for (const sub of listTicketSubscribers(msg.ticket_id)) {
            recipients.add(sub);
        }
    }
    for (const sub of listProjectSubscribers(msg.project)) {
        recipients.add(sub);
    }
    for (const r of recipients) {
        if (r === msg.by_agent) continue;
        insertPing(r, msg.id);
    }
}

/**
 * Closing OR reopening your own ticket is not a moderation matter — the
 * original author already had authority over the thread. Skip rules/strategy
 * when the close/reopen event's by_agent matches the parent ticket's
 * by_agent.
 */
function isOwnerLifecycleEvent(input: NewMessage): boolean {
    if (input.kind !== "ticket_closed" && input.kind !== "ticket_reopened") {
        return false;
    }
    if (!input.by_agent || !input.ticket_id) return false;
    const parent = getMessage(input.ticket_id);
    return (
        parent?.kind === "ticket_created" &&
        parent.by_agent === input.by_agent
    );
}

/**
 * Single source of truth for "a new message arrived" — used by both the HTTP
 * API and the spool drainer so behavior is identical regardless of channel.
 */
export function submitMessage(input: NewMessage): Message {
    let msg = insertMessage(input);
    autoSubscribeAuthor(msg);
    // Always announce the message: every UI list (pending, approved, tickets,
    // open thread) wants to know that a new row exists, regardless of how
    // moderation will resolve it.
    broadcast({ type: "message_created", data: msg });

    const ownerLifecycle = isOwnerLifecycleEvent(input);
    const decision = ownerLifecycle
        ? { decision: "auto" as const, matched_rule_id: null }
        : evaluate({
            project: input.project,
            kind: input.kind,
            by_agent: input.by_agent ?? null,
        });
    if (decision.decision === "auto") {
        const updated = updateMessageStatus(
            msg.id,
            "approved",
            ownerLifecycle ? "owner" : "auto",
            decision.matched_rule_id,
        );
        if (updated) {
            msg = updated;
            deliverToOutbox(msg);
            fanOutPings(msg);
            // …and announce the auto-approval so subscribers transition state
            // (status: pending → approved) without polling.
            broadcast({ type: "message_decided", data: msg });
        }
    }
    return msg;
}

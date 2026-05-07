import {
    insertMessage,
    updateMessageStatus,
    type Message,
    type NewMessage,
    type MessageKind,
} from "./db.js";
import { evaluate } from "./rules.js";
import { deliverToOutbox } from "./outbox.js";
import { broadcast } from "./ws.js";

export const VALID_KINDS: MessageKind[] = [
    "ticket_created",
    "comment_added",
    "ticket_closed",
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
    return {
        project: o.project,
        kind,
        ticket_id: typeof o.ticket_id === "number" ? o.ticket_id : null,
        parent_id: typeof o.parent_id === "number" ? o.parent_id : null,
        title: typeof o.title === "string" ? o.title : null,
        body: typeof o.body === "string" ? o.body : null,
        by_agent: typeof o.by_agent === "string" ? o.by_agent : null,
    };
}

/**
 * Single source of truth for "a new message arrived" — used by both the HTTP
 * API and the spool drainer so behavior is identical regardless of channel.
 */
export function submitMessage(input: NewMessage): Message {
    let msg = insertMessage(input);
    // Always announce the message: every UI list (pending, approved, tickets,
    // open thread) wants to know that a new row exists, regardless of how
    // moderation will resolve it.
    broadcast({ type: "message_created", data: msg });

    const decision = evaluate({
        project: input.project,
        kind: input.kind,
        by_agent: input.by_agent ?? null,
    });
    if (decision.decision === "auto") {
        const updated = updateMessageStatus(
            msg.id,
            "approved",
            "auto",
            decision.matched_rule_id,
        );
        if (updated) {
            msg = updated;
            deliverToOutbox(msg);
            // …and announce the auto-approval so subscribers transition state
            // (status: pending → approved) without polling.
            broadcast({ type: "message_decided", data: msg });
        }
    }
    return msg;
}

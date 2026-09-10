/**
 * Moderation side-effects, shared (#2180).
 *
 * A pending message a moderator approves or rejects has to ripple the same way
 * whichever door the decision came through: outbox delivery, ping fan-out (or
 * ping cleanup on a reject), the author's decision ping, the websocket
 * broadcast, and the lifecycle events the rules engine listens to.
 * `POST /messages/:id/approve` did this inline; the pending-children sweep needs
 * the exact same ripple per child, and a second copy would be the one that
 * quietly stops matching the first.
 *
 * The caller owns the checks — the message exists, is still pending, and the
 * caller may moderate. This only applies the status and ripples it.
 */
import { deletePingsForMessage, updateMessageStatus, type Message, type MessageStatus } from "../db.js";
import { emitLifecycle } from "../event-bus.js";
import { fanOutPings, notifyDecision } from "../notifications.js";
import { deliverToOutbox } from "../outbox.js";
import { broadcast } from "../ws.js";
import { withTagsOne } from "./_helpers.js";

export function applyModeration(existing: Message, status: MessageStatus, decider: string) {
    const updated = updateMessageStatus(existing.id, status, "human", null, existing.kind);
    if (!updated) return null;
    if (status === "approved") {
        deliverToOutbox(updated);
        // #B.245 — fanOutPings self-gates on scope=="internal".
        fanOutPings(updated);
    } else if (status === "rejected") {
        // At-insertion fan-out had already delivered pings to subscribers.
        // The message will never be approved, so wipe those pings so it
        // stops surfacing as unread on their inboxes.
        deletePingsForMessage(existing.id);
    }
    // Transition ping: notify the message author that a moderator decided
    // their submission (#260), whichever path the decision came through.
    if (status === "approved" || status === "rejected") {
        notifyDecision(updated, decider);
    }
    const decorated = withTagsOne(updated);
    broadcast({ type: "message_decided", data: decorated });
    // #321 phase 2 — the rules engine (#322) reacts to the now-live message.
    emitLifecycle({ op: "decided", message: decorated });
    // #509 — a dedicated status_changed so the ticket_status_changed automation
    // fires. old_status is "pending": callers only get here from pending.
    if (decorated.kind === "ticket_created") {
        emitLifecycle({ op: "status_changed", message: decorated, old_status: "pending" });
    }
    return decorated;
}

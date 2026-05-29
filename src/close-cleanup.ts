/**
 * #586 — close-time cleanup operations extracted from `submitMessage`.
 *
 * When a ticket is closed, two distinct cleanups happen on every dangling
 * proposal that targets the same ticket. Originally inlined inside the
 * `input.kind === "ticket_closed"` branch of `submitMessage`; pulling them
 * out makes each operation independently readable AND independently
 * testable (the focused tests live in `src/close-cleanup.test.ts`).
 *
 * Each helper owns its full side-effect chain (deliver / fan-out / broadcast /
 * delete-pings) — callers don't need to mirror them.
 */
import {
    applyMessageDecision,
    deletePingsForMessage,
    listPendingLifecycleForTicket,
    listPendingResolutionDecisionsForTicket,
    listPendingResolvedForTicket,
    updateMessageStatus,
} from "./db.js";
import { deliverToOutbox } from "./outbox.js";
import { fanOutPings } from "./notifications.js";
import { broadcast } from "./ws.js";

/**
 * Closing a ticket is the canonical "yes, this is done" — any dangling
 * resolution proposal on it is implicitly accepted, the close IS the
 * validation. Covers both shapes:
 *   - legacy `ticket_resolved` lifecycle rows (pre-#B.129)
 *   - decision-on-comment resolutions (#B.129)
 *
 * Each promoted lifecycle row gets the standard outbox+fan-out+broadcast
 * cycle so subscribers see the transition without polling. Decision-on-
 * comment accepts only need a `message_edited` broadcast (no fan-out —
 * the underlying comment was already delivered at submit time).
 */
export function autoApproveStaleDecisionsOnClose(
    closedTicketId: number,
    decidedBy: string,
): void {
    for (const stale of listPendingResolvedForTicket(closedTicketId)) {
        const promoted = updateMessageStatus(
            stale.id,
            "approved",
            "owner",
            null,
            stale.kind, // #569 — disambiguate tickets vs messages on id collision
        );
        if (promoted) {
            deliverToOutbox(promoted);
            fanOutPings(promoted);
            broadcast({ type: "message_decided", data: promoted });
        }
    }
    for (const c of listPendingResolutionDecisionsForTicket(closedTicketId)) {
        const accepted = applyMessageDecision(c.id, "accepted", decidedBy);
        if (accepted) {
            broadcast({ type: "message_edited", data: accepted });
        }
    }
}

/**
 * Once a close (or re-open) lands, every other pending `ticket_closed` /
 * `ticket_reopened` proposal on the same ticket is moot — auto-reject
 * them so they stop polluting the moderation queue, and wipe their pings
 * (delivered at submit time, now obsolete).
 *
 * `excludeMessageId` is the just-approved lifecycle row — don't reject what
 * we just promoted (the caller passes the close/reopen we're processing).
 */
export function rejectStaleClosedReopenedForTicket(
    closedTicketId: number,
    excludeMessageId: number,
): void {
    for (const stale of listPendingLifecycleForTicket(
        closedTicketId,
        ["ticket_closed", "ticket_reopened"],
        excludeMessageId,
    )) {
        const rejected = updateMessageStatus(
            stale.id,
            "rejected",
            "owner",
            null,
            stale.kind, // #569 — disambiguate
        );
        if (rejected) {
            deletePingsForMessage(stale.id);
            broadcast({ type: "message_decided", data: rejected });
        }
    }
}

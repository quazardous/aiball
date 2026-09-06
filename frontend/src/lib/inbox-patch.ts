// #2072 — deciding what a live event should do to the list: touch one row, or
// re-read the page.
//
// Pure, so it tests without a DOM or a network. The whole difficulty is that
// the browser holds ONE PAGE of a sorted list — 25 rows out of two thousand —
// so it cannot know, on its own, whether an event changes who belongs on that
// page. A ticket whose activity bumps should jump to the top and push another
// one off; a client that only patches would show a stale membership and never
// notice.
//
// So the rule david accepted: patch what is in memory, and re-read the page
// whenever membership might have moved. Re-reading costs one page (~26 KB, the
// price paid on EVERY event before this), and it has the property the other
// options lack — it is never wrong.

import type { Message } from "./api";

export type InboxUpdate =
    /** Re-read this one row: it is on screen and only its content moved. */
    | { kind: "patch"; ticketId: number }
    /** Re-read the current page: who belongs on it may have changed. */
    | { kind: "refetch" }
    /** Nothing to do — the event says nothing about this list. */
    | { kind: "ignore" };

/**
 * Message kinds that can change WHICH tickets belong on the page, rather than
 * just what one of them says. A close can drop a row out of an open-only view;
 * a reopen can bring one back; a new ticket can land anywhere in the order.
 */
const MEMBERSHIP_KINDS = new Set([
    "ticket_created",
    "ticket_closed",
    "ticket_reopened",
]);

export interface InboxUpdateCtx {
    /** Ticket ids currently held by the browser — the visible page. */
    visible: ReadonlySet<number>;
}

/**
 * What to do about `msg`.
 *
 * Deliberately biased toward `refetch`: being wrong here means showing a list
 * that quietly disagrees with the server, which is worse than one extra page
 * read. Every `patch` is a case where we can prove only the row's own content
 * can have changed.
 */
export function decideInboxUpdate(
    msg: Pick<Message, "kind" | "ticket_id" | "id"> | null | undefined,
    ctx: InboxUpdateCtx,
): InboxUpdate {
    if (!msg) return { kind: "ignore" };

    // A ticket_created message IS the ticket; everything else points at one.
    const ticketId = msg.kind === "ticket_created" ? msg.id : msg.ticket_id;
    if (ticketId === null || ticketId === undefined) {
        // No ticket to aim at — we cannot patch precisely, so re-read.
        return { kind: "refetch" };
    }

    if (msg.kind && MEMBERSHIP_KINDS.has(msg.kind)) return { kind: "refetch" };

    // Not on screen: it may need to ENTER the page (in activity order, a
    // comment sends its ticket to the top). Only the server can say.
    if (!ctx.visible.has(ticketId)) return { kind: "refetch" };

    return { kind: "patch", ticketId };
}

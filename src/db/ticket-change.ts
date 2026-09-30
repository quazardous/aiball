/**
 * #3388 — "this ticket changed": said once by every write of the db layer, after
 * the write, and heard by whatever keeps a copy of a ticket's state (the inbox
 * aggregate, the actionable sets, the bus's subjects). A write names what it
 * touched; it does not know who listens.
 *
 * A leaf: it imports nothing, so a db module can say it and any module can
 * listen without an import cycle. In memory and synchronous: every listener has
 * run when `ticketChanged` returns, so a read that follows the write sees
 * repaired copies. Not stored: a listener is a cache of this process.
 */
export interface TicketChange {
    /** Every ticket whose state the write may have changed (the thread's, and
     *  the other end of a relation). Empty with `everything`. */
    ticket_ids: readonly number[];
    /** The ticket whose THREAD was written (a message added, edited, decided,
     *  deleted), with its project; null when only tickets' own rows changed
     *  (a claim, an assignment, a snooze). */
    thread: { ticket_id: number; project: string } | null;
    /** The write cannot name what it touched (a thread moved between projects,
     *  a re-read that came back empty): every copy is suspect. */
    everything?: boolean;
}

type Listener = (change: TicketChange) => void;
const listeners = new Set<Listener>();

/** Hear every change; returns the way to stop. Listeners run in the order they registered. */
export function onTicketChanged(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/**
 * Say a write, after it. A listener that throws is logged and does not stop the
 * others: the write has happened, and the copies the others keep still need it.
 */
export function ticketChanged(change: TicketChange): void {
    for (const listener of listeners) {
        try {
            listener(change);
        } catch (e) {
            console.error("[ticket-change] a listener failed:", e);
        }
    }
}

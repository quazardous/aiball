/**
 * Snooze reveal cron (per #B.329). Every 60s, find tickets whose
 * `postponed_until` has passed, clear the field, and broadcast a
 * `message_edited` so the UI bounces them back into the open inbox.
 * The ticket was never actually closed (snooze ≠ close), so no
 * synthetic `ticket_reopened` event is needed — clearing the field
 * is enough.
 *
 * Moved out of `daemon.ts` with #1566 (scheduler extraction), unchanged.
 * Its own `try/catch` is kept even though the runner also guards every task:
 * this one logs with the `[postpone]` prefix and lets the loop finish, which
 * the generic guard can't do at that granularity.
 */
import { listExpiredPostpones, setTicketPostpone, getMessage } from "../db.js";
import { broadcast as wsBroadcast } from "../ws.js";

export function revealExpiredPostpones(): void {
    try {
        const ids = listExpiredPostpones();
        for (const id of ids) {
            setTicketPostpone(id, null);
            const updated = getMessage(id);
            if (updated) wsBroadcast({ type: "message_edited", data: updated });
        }
        if (ids.length > 0) {
            console.log(`[postpone] revealed ${ids.length} ticket${ids.length === 1 ? "" : "s"}`);
        }
    } catch (e) {
        console.error("[postpone] reveal cron failed:", e);
    }
}

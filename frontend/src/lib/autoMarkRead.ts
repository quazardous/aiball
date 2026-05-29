/**
 * Auto-mark-as-read dwell timer for a single thread (#B.196 Layer 3
 * extract from ThreadView). After the user lands on a ticket and
 * leaves it open for AUTO_MARK_READ_MS, fire api.markTicketRead with
 * an up_to_id snapshot (#B.191 — comments arriving AFTER the timer
 * keep their unseen ping so the inbox row stays bold+green for new
 * content). Pure side-effect composable: it wires a watcher that
 * resets the timer on ticketId change and an onBeforeUnmount cleanup.
 *
 * #596 — also returns a `markingRead` ref that flips true while the
 * dwell timer is running on an UNREAD ticket, so the UI can render a
 * visual "transition in progress" hint (a pulsing dot, etc.).
 */
import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { api, type ThreadView as ThreadViewData } from "./api";
import { bus } from "./bus";

const AUTO_MARK_READ_MS = 2000;

interface UseAutoMarkReadArgs {
    data: Ref<ThreadViewData | null>;
    ticketId: () => number;
}

interface UseAutoMarkReadReturn {
    /** True while the dwell timer is counting down on an UNREAD ticket
     *  — the UI uses it to render the "marking-as-read" pulse (#596). */
    markingRead: Ref<boolean>;
    /** Same constant the timer uses, exposed so the UI can sync its
     *  CSS animation duration to the dwell window without re-encoding it. */
    dwellMs: number;
}

export function useAutoMarkRead({ data, ticketId }: UseAutoMarkReadArgs): UseAutoMarkReadReturn {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const markingRead = ref(false);

    function schedule() {
        if (timer) {
            clearTimeout(timer);
            markingRead.value = false;
        }
        const id = ticketId();
        // #596 — always paint the pulse during the dwell. We don't gate
        // on "was the ticket unread when we landed" because the
        // ThreadView's TicketSummary doesn't carry the per-consumer
        // unread flag (only the inbox row does). The mark-read call is a
        // cheap no-op when the ticket was already read, and a brief
        // pulse on every visit is less surprising than an inconsistent
        // "sometimes-pulse" behaviour. KISS for the first cut.
        markingRead.value = true;
        timer = setTimeout(() => {
            const snapshot = data.value;
            const lastSeenId = snapshot && snapshot.ticket?.id === id
                ? Math.max(
                    snapshot.ticket.id,
                    ...snapshot.comments.map((c) => c.id),
                  )
                : undefined;
            api.markTicketRead(id, lastSeenId)
                .then(() => {
                    // Read state is per-consumer, so the server doesn't
                    // broadcast it on WS. Push it onto the bus so the
                    // sidebar/list badges follow.
                    bus.emit("read-state.changed", {
                        ticket_id: id,
                        consumer_id: localStorage.getItem("aiball.human_id") ?? "human",
                        unread: false,
                    });
                    bus.emit("projects.refresh");
                    bus.emit("inbox.refresh");
                })
                .catch(() => {/* silent — read state is best-effort */});
            timer = null;
            markingRead.value = false;
        }, AUTO_MARK_READ_MS);
    }

    watch(ticketId, schedule, { immediate: true });

    onBeforeUnmount(() => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        markingRead.value = false;
    });

    return { markingRead, dwellMs: AUTO_MARK_READ_MS };
}

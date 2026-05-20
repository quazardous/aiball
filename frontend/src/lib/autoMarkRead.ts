/**
 * Auto-mark-as-read dwell timer for a single thread (#B.196 Layer 3
 * extract from ThreadView). After the user lands on a ticket and
 * leaves it open for AUTO_MARK_READ_MS, fire api.markTicketRead with
 * an up_to_id snapshot (#B.191 — comments arriving AFTER the timer
 * keep their unseen ping so the inbox row stays bold+green for new
 * content). Pure side-effect composable: it wires a watcher that
 * resets the timer on ticketId change and an onBeforeUnmount cleanup.
 * Nothing to destructure on the call site.
 */
import { onBeforeUnmount, watch, type Ref } from "vue";
import { api, type ThreadView as ThreadViewData } from "./api";
import { bus } from "./bus";

const AUTO_MARK_READ_MS = 2000;

interface UseAutoMarkReadArgs {
    data: Ref<ThreadViewData | null>;
    ticketId: () => number;
}

export function useAutoMarkRead({ data, ticketId }: UseAutoMarkReadArgs): void {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
        if (timer) clearTimeout(timer);
        const id = ticketId();
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
        }, AUTO_MARK_READ_MS);
    }

    watch(ticketId, schedule, { immediate: true });

    onBeforeUnmount(() => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    });
}

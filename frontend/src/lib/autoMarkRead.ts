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
 * dwell timer is running on an UNREAD ticket (per-consumer flag on the
 * thread payload), so the UI can render a "transition in progress"
 * pulse. Re-visits of an already-read ticket: chip stays static.
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
    let scheduledForId: number | null = null;
    // #770 — highest comment id we've already confirmed mark-read for on
    // this ticket. A new comment arriving via SSE / bus refresh that
    // overshoots this watermark re-arms the dwell (envelope blink again),
    // so a user dwelling on an open thread still gets a fresh
    // notification-then-mark cycle. `null` = nothing confirmed yet.
    let readUpToId: number | null = null;

    function highestId(snapshot: ThreadViewData): number {
        return Math.max(
            snapshot.ticket.id,
            ...snapshot.comments.map((c) => c.id),
        );
    }

    function cancel() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        markingRead.value = false;
        scheduledForId = null;
        readUpToId = null;
    }

    // Schedule fires when `data` has loaded for the current ticketId. We
    // also re-fire when a fresh refresh exposes a comment id higher than
    // the last confirmed mark-read watermark (#770) — that's the "a new
    // comment arrived while I was reading" path. #596 david `sa44wy` :
    // pas de flicker sur un ticket déjà lu sans nouveau contenu (la chip
    // reste grise statique).
    function maybeSchedule() {
        const id = ticketId();
        const snapshot = data.value;
        if (!snapshot || snapshot.ticket?.id !== id) return;
        const top = highestId(snapshot);
        if (scheduledForId === id) {
            // Already scheduled / completed for this ticket. Skip unless
            // a NEW comment has landed past our last mark-read.
            if (readUpToId === null || top <= readUpToId) return;
            // New content arrived — cancel any in-flight dwell and re-arm.
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }
        scheduledForId = id;
        markingRead.value = snapshot.ticket.unread === true;
        timer = setTimeout(() => {
            const lastSeenId = data.value && data.value.ticket?.id === id
                ? highestId(data.value)
                : undefined;
            api.markTicketRead(id, lastSeenId)
                .then(() => {
                    if (lastSeenId !== undefined) readUpToId = lastSeenId;
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

    watch(ticketId, cancel);
    watch(data, maybeSchedule, { immediate: true });

    onBeforeUnmount(() => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        markingRead.value = false;
    });

    return { markingRead, dwellMs: AUTO_MARK_READ_MS };
}

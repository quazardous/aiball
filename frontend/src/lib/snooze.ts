/**
 * Snooze composable for a single thread view (#B.196 Layer 3 extract
 * from ThreadView). Owns the popover ref + busy flag + the three
 * "set aside until …" verbs (preset durations, custom datetime, and
 * unsnooze). All three embark any text typed in the composer as a
 * regular comment first (#B.63: snooze trail with reason).
 *
 * Caller wires the popover element via `popoverRef`, the ticket data
 * via `data`, the in-thread composer state via `composerBody` +
 * `postBodyAs`, and the parent's error sink via `error`. Refresh
 * broadcasts go through the global event bus.
 */
import { computed, ref, type Ref } from "vue";
import type Popover from "primevue/popover";
import { api, type ThreadView as ThreadViewData } from "./api";
import { bus } from "./bus";

interface UseSnoozeArgs {
    data: Ref<ThreadViewData | null>;
    composerBody: Ref<string>;
    postBodyAs: (kind: "comment_added") => Promise<void>;
    error: Ref<string | null>;
}

export function useSnooze({ data, composerBody, postBodyAs, error }: UseSnoozeArgs) {
    const snoozeBusy = ref(false);
    const popoverRef = ref<InstanceType<typeof Popover> | null>(null);
    const snoozeCustom = ref("");

    function openSnoozePopover(ev: MouseEvent) {
        snoozeCustom.value = "";
        popoverRef.value?.show(ev);
    }

    async function snoozeUntil(untilIso: string) {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        snoozeBusy.value = true;
        try {
            // #B.63: if the composer has body text, post it as a
            // comment before the snooze — keeps the audit trail with
            // the typed context ("snoozing because waiting on X").
            // Empty composer → just the snooze, same as before.
            if (composerBody.value.trim()) {
                await postBodyAs("comment_added");
                composerBody.value = "";
            }
            await api.postponeTicket(tid, untilIso);
            popoverRef.value?.hide();
            bus.emit("thread.refresh", { ticketId: tid });
            bus.emit("inbox.refresh");
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            snoozeBusy.value = false;
        }
    }

    function snoozeFor(ms: number) {
        return snoozeUntil(new Date(Date.now() + ms).toISOString());
    }

    async function snoozeCustomSubmit() {
        if (!snoozeCustom.value) return;
        const ts = Date.parse(snoozeCustom.value);
        if (!Number.isFinite(ts) || ts <= Date.now()) {
            error.value = "Snooze date must be a valid future ISO8601 timestamp";
            return;
        }
        await snoozeUntil(new Date(ts).toISOString());
    }

    async function unsnooze() {
        if (!data.value) return;
        const tid = data.value.ticket.id;
        snoozeBusy.value = true;
        try {
            await api.unsnoozeTicket(tid);
            bus.emit("thread.refresh", { ticketId: tid });
            bus.emit("inbox.refresh");
        } catch (e) {
            error.value = (e as Error).message;
        } finally {
            snoozeBusy.value = false;
        }
    }

    const isSnoozed = computed(() => {
        if (!data.value?.ticket.postponed_until) return false;
        return Date.parse(data.value.ticket.postponed_until) > Date.now();
    });

    return {
        snoozeBusy,
        popoverRef,
        snoozeCustom,
        openSnoozePopover,
        snoozeFor,
        snoozeCustomSubmit,
        unsnooze,
        isSnoozed,
    };
}

<script setup lang="ts">
/**
 * "Overview" tab content of the consumer detail page (extracted from
 * ConsumerEditPage.vue). Read-only identity + loop status + meta, plus
 * the destructive actions band (Stop loop / Delete consumer).
 *
 * Seam: `original` in ; `close` out (after delete, so the parent page
 * closes) ; `refresh` out (backstop re-load after a Stop, mirrors the
 * old in-parent `setTimeout(load, 1500)`).
 */
import { computed, ref } from "vue";
import Button from "primevue/button";
import { useConfirm } from "primevue/useconfirm";
import { api, type Consumer } from "../lib/api";
import { useNotify } from "../lib/notify";
import { activityClass, presenceClass, presenceWord } from "../lib/consumer-status";
import { relativeTime } from "../lib/format";
import FieldRow from "./ui/FieldRow.vue";

const props = defineProps<{ original: Consumer }>();
const emit = defineEmits<{
    (e: "close"): void;
    (e: "refresh"): void;
}>();

const notify = useNotify();
const confirmDialog = useConfirm();
const stopBusy = ref(false);
const deleteBusy = ref(false);
const pruneBusy = ref(false);

// #460 — same online/offline criterion as ProjectDetailPage + ConsumersPanel :
// presence-AUTHORITATIVE, with the 120s heartbeat as a bridge for never-seen-
// via-SSE cases (just after a daemon restart). Surface it as a computed so the
// "Loop status" section + the Stop button visibility stay derived.
const ONLINE_MS = 120_000;
const isOnline = computed((): boolean => {
    const c = props.original;
    if (!c) return false;
    if (c.present === true) return true;
    if (c.present === false) return false;
    if (!c.state_updated_at) return false;
    return Date.now() - new Date(c.state_updated_at).getTime() < ONLINE_MS;
});
// Stop is only meaningful when a loop is actually live AND has a `state` (a
// human consumer has no loop to kill).
const canStop = computed((): boolean => !!props.original?.state && isOnline.value);

// #460 — centralised remote hard-kill (mirrors ConsumersPanel + ProjectDetailPage).
// Confirm modal gates it so a stray click never kills a loop. Once #460
// "centralise on the consumer detail" lands fully, the inline shortcuts in the
// list pages can be removed if david wants — left in for now as fast paths.
function stopLoop(): void {
    if (!props.original) return;
    const consumer_id = props.original.consumer_id;
    confirmDialog.require({
        header: "Stop loop",
        message: `Stop the claude-loop running as "${consumer_id}"? This kills its tmux session + Claude (the conversation is lost). Its state is kept — use Delete to remove it entirely.`,
        icon: "pi pi-stop-circle",
        acceptLabel: "Stop",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doStopLoop(consumer_id); },
    });
}
async function doStopLoop(consumer_id: string): Promise<void> {
    stopBusy.value = true;
    try {
        const r = await api.stopLoop(consumer_id);
        if (r.delivered) {
            notify.success(`Stop sent to ${consumer_id}`, { detail: "The loop will self-terminate." });
        } else {
            notify.warn(`No live loop for ${consumer_id}`, { detail: "Nothing was connected to receive it." });
        }
        // Backstop the WS broadcast in case it lags : refresh after a beat.
        setTimeout(() => emit("refresh"), 1500);
    } catch (e) {
        notify.error(`Stop failed for ${consumer_id}`, { detail: (e as Error).message });
    } finally {
        stopBusy.value = false;
    }
}

// #469 — Delete consumer, mirrored from the ConsumersPanel pre-#468 inline
// action (now retired from the list). Confirm + delete via the same API
// the list used. On success we close the detail page so the operator
// doesn't stare at a stale form.
function deleteConsumer(): void {
    if (!props.original) return;
    const consumer_id = props.original.consumer_id;
    confirmDialog.require({
        header: "Delete consumer",
        message: `Delete consumer "${consumer_id}"? Past posts are preserved ; the row will be re-created the next time this id posts.`,
        icon: "pi pi-trash",
        acceptLabel: "Delete",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doDelete(consumer_id); },
    });
}
async function doDelete(consumer_id: string): Promise<void> {
    deleteBusy.value = true;
    try {
        await api.deleteConsumer(consumer_id);
        notify.success(`Consumer ${consumer_id} deleted`);
        emit("close");
    } catch (e) {
        notify.error(`Delete failed for ${consumer_id}`, { detail: (e as Error).message });
    } finally {
        deleteBusy.value = false;
    }
}

// #1185 — operator prune of this consumer's ping backlog (across all
// projects). Mark-seen is the safe default (rows kept, resurfaceable) ;
// del=true hard-removes the ping rows. Gated server-side to the human
// moderator (this UI). Mirrors the Stop/Delete confirm+notify pattern.
function prunePings(del: boolean): void {
    if (!props.original) return;
    const consumer_id = props.original.consumer_id;
    confirmDialog.require({
        header: del ? "Delete all pings" : "Mark all pings seen",
        message: del
            ? `Hard-DELETE every ping row for "${consumer_id}" across all projects? The pings are just notification pointers — tickets and comments are untouched. Not resurfaceable.`
            : `Mark every unread ping for "${consumer_id}" as seen, across all projects? Drains the backlog ; rows are kept (resurfaceable).`,
        icon: del ? "pi pi-trash" : "pi pi-check",
        acceptLabel: del ? "Delete" : "Mark seen",
        rejectLabel: "Cancel",
        acceptClass: del ? "p-button-danger" : "p-button-primary",
        accept: () => { void doPrune(consumer_id, del); },
    });
}
async function doPrune(consumer_id: string, del: boolean): Promise<void> {
    pruneBusy.value = true;
    try {
        const r = (await api.markReadProject({ consumer: consumer_id, allProjects: true, del })) as { affected?: number };
        const n = r.affected ?? 0;
        notify.success(
            `${del ? "Deleted" : "Marked seen"} ${n} ping${n === 1 ? "" : "s"} for ${consumer_id}`,
        );
        emit("refresh");
    } catch (e) {
        notify.error(`Prune failed for ${consumer_id}`, { detail: (e as Error).message });
    } finally {
        pruneBusy.value = false;
    }
}
</script>

<template>
    <div class="consumer-edit__tab">
        <FieldRow label="consumer_id">
            <span class="aiball-mono">{{ original.consumer_id }}</span>
        </FieldRow>

        <!-- Loop status : chips read-only (mêmes que
             ProjectDetailPage / ConsumersPanel #460).
             #469 david : le bouton Stop micro-inline a
             migré dans le band d'actions en bas de
             l'overview (vrai bouton form-style). -->
        <FieldRow label="loop status">
            <div class="consumer-edit__status">
                <template v-if="original.state">
                    <template v-if="isOnline">
                        <span class="ld-tag" :class="activityClass(original.state)">{{ original.state }}</span>
                        <span
                            class="ld-tag"
                            :class="presenceClass(original.state_human, original.state_human_word)"
                        >{{ presenceWord(original.state_human, original.state_human_word) }}</span>
                    </template>
                    <span v-else class="ld-tag ld-tag--offline">offline</span>
                    <span v-if="original.cwd" class="consumer-edit__cwd" :title="original.cwd">
                        @ <code>{{ original.cwd }}</code>
                    </span>
                </template>
                <span v-else class="consumer-edit__status-none">
                    no loop tracking — this consumer has never reported a state
                </span>
            </div>
        </FieldRow>

        <FieldRow label="kind">
            <span>{{ original.kind }}</span>
        </FieldRow>
        <FieldRow v-if="original.display_name" label="display name">
            <span>{{ original.display_name }}</span>
        </FieldRow>
        <FieldRow label="enabled">
            <span :class="original.enabled ? '' : 'consumer-edit__status-none'">
                {{ original.enabled ? "enabled" : "blocked" }}
            </span>
        </FieldRow>

        <div class="consumer-edit__meta">
            <div><strong>created</strong> {{ original.created_at ? relativeTime(original.created_at) : "—" }}</div>
            <div><strong>last seen</strong> {{ original.last_seen_at ? relativeTime(original.last_seen_at) : "never" }}</div>
        </div>

        <!-- #469 david `b910e4` : les micro-boutons d'action
             inline (Stop, Delete) migrent en BAS de l'overview
             sous forme de vrais boutons "form style" — labels
             lisibles, taille standard, severity colorée. Stop
             reste gated par `canStop` (online + has state) ;
             Delete est toujours dispo. -->
        <div class="consumer-edit__actions">
            <Button
                v-if="canStop"
                label="Stop loop"
                icon="pi pi-stop-circle"
                severity="danger"
                outlined
                :loading="stopBusy"
                :title="`Stop (hard-kill) the claude-loop running as ${original.consumer_id}`"
                @click="stopLoop"
            />
            <Button
                label="Mark pings seen"
                icon="pi pi-check"
                severity="secondary"
                outlined
                :loading="pruneBusy"
                :title="`Drain the ping backlog of ${original.consumer_id} (mark seen, all projects)`"
                @click="prunePings(false)"
            />
            <Button
                label="Delete pings"
                icon="pi pi-eraser"
                severity="warn"
                outlined
                :loading="pruneBusy"
                :title="`Hard-delete every ping row of ${original.consumer_id} (all projects)`"
                @click="prunePings(true)"
            />
            <Button
                label="Delete consumer"
                icon="pi pi-trash"
                severity="danger"
                outlined
                :loading="deleteBusy"
                :title="`Delete consumer ${original.consumer_id} (history preserved)`"
                @click="deleteConsumer"
            />
        </div>
    </div>
</template>

<style>
/* Non-scoped, same convention as ConsumerEditPage. Only the rules whose
   markup lives EXCLUSIVELY in this panel moved here ; shared classes
   (`consumer-edit__tab`, `consumer-edit__actions`) stay in the parent. */
/* #460 — loop status row : tags + cwd + Stop button on one line. */
.consumer-edit__status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
}
.consumer-edit__cwd {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.consumer-edit__cwd code {
    font-family: var(--font-mono);
    font-size: 0.74rem;
}
.consumer-edit__status-none {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
    font-style: italic;
}
.consumer-edit__meta {
    display: flex;
    gap: 1.5rem;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
</style>

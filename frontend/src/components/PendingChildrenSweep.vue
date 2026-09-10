<script setup lang="ts">
/**
 * #2180 — approve a ticket's pending children in one gesture.
 *
 * Mounted only when the ticket has `parent_of` chips, so a ticket without
 * children costs no request; renders nothing when none of them is pending.
 *
 * The dialog is the point, not a formality: it lists each pending child with
 * WHO attached it. A child hung under the ticket by its own author needs no
 * second read; one attached by someone else is exactly what could ride an
 * approval nobody gave it, so those rows are flagged. The approval sends the
 * ids ticked here and nothing else — the daemon re-checks each one and refuses
 * anything no longer a pending child, so a child attached while the dialog was
 * open is never swept along.
 */
import { computed, ref } from "vue";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { api, type PendingChild } from "../lib/api";
import { useLoader } from "../lib/loader";
import { useNotify } from "../lib/notify";

const props = defineProps<{ ticketId: number; reporter: string | null }>();
const emit = defineEmits<{ (e: "done"): void }>();

const children = ref<PendingChild[]>([]);
const error = ref<string | null>(null);
const open = ref(false);
const busy = ref(false);
const ticked = ref<Set<number>>(new Set());
const notify = useNotify();

const { load } = useLoader(async () => {
    children.value = (await api.pendingChildren(props.ticketId)).children;
}, { error, mountLoad: true });

/** Attached by someone other than the ticket's author — worth a second read. */
const foreign = (c: PendingChild) => c.attached_by !== props.reporter;
const foreignCount = computed(() => children.value.filter(foreign).length);

function openDialog() {
    // Everything ticked by default, derived from the very list the dialog shows.
    ticked.value = new Set(children.value.map((c) => c.ticket_id));
    open.value = true;
}

function toggle(id: number) {
    const next = new Set(ticked.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    ticked.value = next;
}

async function approve() {
    const ids = children.value.map((c) => c.ticket_id).filter((id) => ticked.value.has(id));
    if (ids.length === 0) return;
    busy.value = true;
    try {
        const r = await api.approvePendingChildren(props.ticketId, ids);
        if (r.skipped.length > 0) {
            notify.error(`Approved ${r.approved.length}, skipped ${r.skipped.length}`, {
                detail: r.skipped.map((s) => `#${s.ticket_id}: ${s.reason}`).join("\n"),
            });
        } else {
            notify.success(`Approved ${r.approved.length} child ticket${r.approved.length === 1 ? "" : "s"}`);
        }
        open.value = false;
        await load();
        emit("done");
    } catch (e) {
        notify.error("Approval failed", { detail: (e as Error).message });
    } finally {
        busy.value = false;
    }
}
</script>

<template>
    <div v-if="children.length" class="pending-children">
        <Button
            size="small"
            severity="warn"
            outlined
            icon="pi pi-check-square"
            :label="`${children.length} pending child${children.length === 1 ? '' : 'ren'}`"
            title="Review and approve this ticket's pending children"
            @click="openDialog"
        />
        <span v-if="foreignCount" class="pending-children__hint">
            {{ foreignCount }} attached by someone other than the author
        </span>
    </div>

    <Dialog
        v-model:visible="open"
        modal
        header="Approve pending children"
        :style="{ width: '40rem', maxWidth: '94vw' }"
    >
        <p class="pending-children__lead">
            These tickets hang under #{{ ticketId }} and still await moderation.
            Only the ticked ones are approved.
        </p>
        <ul class="pending-children__list">
            <li v-for="c in children" :key="c.ticket_id" :class="{ 'is-foreign': foreign(c) }">
                <label>
                    <input
                        type="checkbox"
                        :checked="ticked.has(c.ticket_id)"
                        :disabled="busy"
                        @change="toggle(c.ticket_id)"
                    />
                    <span class="pending-children__title">#{{ c.ticket_id }} {{ c.title }}</span>
                </label>
                <span class="pending-children__meta">
                    {{ c.project }} · attached by <strong>{{ c.attached_by ?? "system" }}</strong>
                    · {{ new Date(c.attached_at).toLocaleString() }}
                    <span v-if="foreign(c)" class="pending-children__flag">not attached by the author</span>
                </span>
            </li>
        </ul>
        <template #footer>
            <Button label="Cancel" text severity="secondary" :disabled="busy" @click="open = false" />
            <Button
                :label="`Approve ${ticked.size}`"
                icon="pi pi-check"
                :loading="busy"
                :disabled="ticked.size === 0"
                @click="approve"
            />
        </template>
    </Dialog>
</template>

<style scoped>
.pending-children {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.25rem 0;
}
.pending-children__hint {
    font-size: 0.85em;
    opacity: 0.75;
}
.pending-children__lead {
    margin: 0 0 0.75rem;
}
.pending-children__list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
}
.pending-children__list li {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px;
}
.pending-children__list li.is-foreign {
    border-color: var(--p-orange-400, #f59e0b);
}
.pending-children__list label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    cursor: pointer;
}
.pending-children__title {
    font-weight: 600;
    overflow-wrap: anywhere;
}
.pending-children__meta {
    padding-left: 1.5rem;
    font-size: 0.85em;
    opacity: 0.8;
}
.pending-children__flag {
    margin-left: 0.4rem;
    color: var(--p-orange-500, #d97706);
}
</style>

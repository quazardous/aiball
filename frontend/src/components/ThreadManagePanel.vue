<script setup lang="ts">
/**
 * #352: inline "manage subscriptions" panel — opens in place like the edit
 * panel (ThreadView `v-if="managing"`). Moderator tool:
 *   - lists the ticket's EXPLICIT subscriptions (follows + mutes) and lets
 *     you mute/unmute each one individually (per-subscription, per david);
 *   - mute-all / unmute-all convenience widget on top;
 *   - reassign the ticket owner (= by_agent / reporter).
 * Self-contained: fetches its own data and calls the API directly.
 */
import { ref, onMounted } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import { api, type TicketSummary } from "../lib/api";

const props = defineProps<{ ticket: TicketSummary }>();
const emit = defineEmits<{ (e: "close"): void }>();

interface SubRow { consumer_id: string; muted: boolean; subscribed_at: string }
const subs = ref<SubRow[]>([]);
const agents = ref<string[]>([]);
const owner = ref<string | null>(props.ticket.by_agent);
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const [s, m] = await Promise.all([
            api.ticketSubscriptions(props.ticket.id),
            api.mentionSuggestions(),
        ]);
        subs.value = s.subscriptions;
        agents.value = m.agents;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}
onMounted(load);

async function toggleMute(row: SubRow) {
    busy.value = true;
    try {
        await api.muteSubscription(props.ticket.id, row.consumer_id, !row.muted);
        row.muted = !row.muted;
    } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function setAll(muted: boolean) {
    busy.value = true;
    try {
        await Promise.all(
            subs.value.map((r) => api.muteSubscription(props.ticket.id, r.consumer_id, muted)),
        );
        subs.value.forEach((r) => { r.muted = muted; });
    } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}

async function changeOwner(next: string | null) {
    if (!next || next === owner.value) return;
    busy.value = true;
    try {
        await api.changeTicketOwner(props.ticket.id, next);
        owner.value = next;
    } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
</script>

<template>
    <div class="thread-manage-panel">
        <div class="tmp-head">
            <span class="tmp-title"><i class="pi pi-users" /> Manage subscriptions</span>
            <Button
                icon="pi pi-times"
                label="close"
                size="small"
                severity="secondary"
                text
                @click="emit('close')"
            />
        </div>

        <div v-if="error" class="tmp-error">{{ error }}</div>

        <div class="tmp-section">
            <div class="tmp-section-head">
                <span class="tmp-label">Subscribers</span>
                <span class="tmp-actions">
                    <Button
                        label="mute all"
                        icon="pi pi-bell-slash"
                        size="small"
                        severity="warn"
                        :disabled="busy || subs.length === 0"
                        @click="setAll(true)"
                    />
                    <Button
                        label="unmute all"
                        icon="pi pi-bell"
                        size="small"
                        severity="success"
                        :disabled="busy || subs.length === 0"
                        @click="setAll(false)"
                    />
                </span>
            </div>
            <p v-if="loading" class="tmp-empty">Loading…</p>
            <p v-else-if="subs.length === 0" class="tmp-empty">
                No explicit subscriptions on this ticket yet (owners pinged by
                project role aren't listed).
            </p>
            <ul v-else class="tmp-list">
                <li
                    v-for="row in subs"
                    :key="row.consumer_id"
                    class="tmp-row"
                    :class="{ muted: row.muted }"
                >
                    <span class="tmp-consumer">{{ row.consumer_id }}</span>
                    <Button
                        :icon="row.muted ? 'pi pi-bell-slash' : 'pi pi-bell'"
                        :label="row.muted ? 'muted' : 'active'"
                        size="small"
                        :severity="row.muted ? 'warn' : 'success'"
                        text
                        :disabled="busy"
                        @click="toggleMute(row)"
                    />
                </li>
            </ul>
        </div>

        <div class="tmp-section">
            <span class="tmp-label">Owner</span>
            <Select
                :model-value="owner"
                :options="agents"
                filter
                placeholder="(reporter)"
                :disabled="busy"
                @update:model-value="changeOwner"
            />
            <small class="tmp-hint">
                Reassign the ticket's reporter/owner. The new owner is subscribed
                and can close/reopen.
            </small>
        </div>
    </div>
</template>

<style scoped>
.thread-manage-panel {
    border: 1px solid var(--p-content-border-color);
    border-radius: 6px;
    background: var(--p-surface-50);
    padding: 0.75rem;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.tmp-head { display: flex; align-items: center; justify-content: space-between; }
.tmp-title { font-weight: 600; display: inline-flex; gap: 0.4rem; align-items: center; }
.tmp-error { color: var(--p-red-500, #e5484d); font-size: 0.8rem; }
.tmp-section { display: flex; flex-direction: column; gap: 0.5rem; }
.tmp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; }
.tmp-actions { display: inline-flex; gap: 0.4rem; }
.tmp-label { font-weight: 600; font-size: 0.85rem; }
.tmp-hint { color: var(--p-text-muted-color); font-size: 0.72rem; line-height: 1.2; }
.tmp-empty { color: var(--p-text-muted-color); font-size: 0.82rem; margin: 0; }
.tmp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
.tmp-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.3rem 0.4rem; border-radius: 4px; }
/* #352: zebra striping on the subscriber rows for readability. */
.tmp-row:nth-child(even) { background: var(--p-surface-100); }
.tmp-row.muted { opacity: 0.7; }
.tmp-consumer { font-family: var(--font-mono, monospace); font-size: 0.85rem; }
</style>

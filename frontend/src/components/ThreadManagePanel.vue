<script setup lang="ts">
/**
 * #352: inline "manage subscriptions" panel — opens in place like the edit
 * panel (ThreadView `v-if="managing"`). Moderator tool:
 *   - lists the ticket's EXPLICIT subscriptions (follows + mutes) and lets
 *     you mute/unmute each one individually (per-subscription, per david);
 *   - mute-all / unmute-all convenience widget on top;
 *   - reassign the ticket owner (= by_agent / reporter);
 *   - move the whole thread to another project (#377 — relocated here from the
 *     edit panel: it's a management action, not a content edit).
 * Subscriptions + owner are self-contained (own fetch + API). The project move
 * is parent-wired (projectOptions + move-change) so it reuses ThreadView's
 * tested move+refresh path.
 */
import { ref, onMounted, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import { api, type TicketSummary } from "../lib/api";

const props = defineProps<{
    ticket: TicketSummary;
    /** #377/#294: destinations for the "move to project" Select (parent loads
     *  lazily when the manage panel opens). Empty/absent → the row is hidden. */
    projectOptions?: { label: string; value: string }[];
    moveBusy?: boolean;
}>();
const emit = defineEmits<{
    (e: "close"): void;
    (e: "move-change", v: string): void;
}>();

interface SubRow { consumer_id: string; muted: boolean; subscribed_at: string }
const subs = ref<SubRow[]>([]);
const agents = ref<string[]>([]);
const owner = ref<string | null>(props.ticket.by_agent);
// #514 (david `ysnj8e`) : assignee aussi éditable depuis la manage panel.
// Liste consumers (vs agents pour owner — owner = "qui a posté", agents
// suffisent ; assignee = "qui doit s'occuper", peut être n'importe quel
// consumer enregistré incl. agents qui n'ont jamais posté).
const consumers = ref<string[]>([]);
const assignee = ref<string | null>(props.ticket.assignee ?? null);
// #902 david `4unc43` : sans ce watch, le local ref capture la value
// initiale au mount mais ne suit pas les refresh du ticket parent
// (ex : ThreadView.load() post-accept-with-assign). Sync explicite
// quand props.ticket change.
watch(() => props.ticket.assignee, (next) => {
    assignee.value = next ?? null;
});
watch(() => props.ticket.by_agent, (next) => {
    owner.value = next;
});
const loading = ref(true);
const busy = ref(false);
const error = ref<string | null>(null);

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const [s, m, c] = await Promise.all([
            api.ticketSubscriptions(props.ticket.id),
            api.mentionSuggestions(),
            api.listConsumers(),
        ]);
        subs.value = s.subscriptions;
        agents.value = m.agents;
        consumers.value = c.map((cc) => cc.consumer_id);
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

// #514 (`ysnj8e`) — change/clear assignee. Empty → API attend "" pour
// self-claim mais ici on veut UNASSIGN. Pas d'endpoint unassign dédié,
// donc on POST assign avec une string vide spéciale ? Non — on utilise
// la release endpoint qui retire l'assignment. Cf. POST /tickets/:id/release.
async function changeAssignee(next: string | null) {
    if (next === (assignee.value ?? null)) return;
    busy.value = true;
    try {
        if (next === null || next === "") {
            // show-clear cliqué → unassign via release endpoint.
            await api.releaseTicket(props.ticket.id);
            assignee.value = null;
        } else {
            await api.assignTicket(props.ticket.id, next);
            assignee.value = next;
        }
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

        <!-- #377: owner + project side by side on desktop, one per line on smartphone.
             #514 (`ysnj8e`): assignee aussi en update — 3 sections wrap. -->
        <div class="tmp-pair">
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

            <div class="tmp-section">
                <span class="tmp-label">Assignee</span>
                <Select
                    :model-value="assignee"
                    :options="consumers"
                    filter
                    show-clear
                    placeholder="(unassigned)"
                    :disabled="busy"
                    @update:model-value="changeAssignee"
                />
                <small class="tmp-hint">
                    Push responsibility to a specific consumer (clear to unassign).
                    Distinct from owner — the assignee is who should act.
                </small>
            </div>

            <div v-if="(projectOptions?.length ?? 0) > 0" class="tmp-section">
                <span class="tmp-label">Project</span>
                <Select
                    :model-value="ticket.project"
                    :options="projectOptions"
                    option-label="label"
                    option-value="value"
                    :disabled="busy || moveBusy"
                    @update:model-value="(v: string) => emit('move-change', v)"
                />
                <small class="tmp-hint">Moves the whole thread to another project (#294).</small>
            </div>
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
/* #377: owner + project pair — stacked (one per line) on smartphone,
 * side by side from the desktop breakpoint (721px, app convention). */
.tmp-pair { display: flex; flex-direction: column; gap: 1rem; }
@media (min-width: 721px) {
    .tmp-pair { flex-direction: row; gap: 1rem; align-items: flex-start; }
    .tmp-pair > .tmp-section { flex: 1; min-width: 0; }
}
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

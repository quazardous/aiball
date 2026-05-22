<script setup lang="ts">
/**
 * Ticket header — title, optional state banners (resolved / closed /
 * snoozed), intent + tags meta strip, optional "edit message" button.
 * #B.196 Layer 3 extract from ThreadView.
 *
 * Two render contexts:
 *   - Bottom-up article: show banners + edit button.
 *   - Top-down headline: title + meta-extra only (banners are state
 *     callouts that belong with the conversation body, not the lifted
 *     header).
 *
 * Driven by `showBanners` + `showEditButton` props so the parent picks
 * which surface it wants; defaults are FALSE so a bare invocation is
 * the minimal-info top-down view.
 */
import { ref, onMounted } from "vue";
import Button from "primevue/button";
import Popover from "primevue/popover";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { api, type TicketSummary } from "../lib/api";

const props = defineProps<{
    ticket: TicketSummary;
    isSnoozed: boolean;
    showBanners?: boolean;
    showEditButton?: boolean;
    editing?: boolean;
}>();
const emit = defineEmits<{ (e: "start-edit"): void }>();

// #352: a single "manage" control next to "edit message" — manage-semantics
// (subscription + owner), distinct from editing content. Self-contained:
// fetches its own state and calls the API directly.
const managePopover = ref<InstanceType<typeof Popover> | null>(null);
const subState = ref<"followed" | "muted" | null>(null);
const agents = ref<string[]>([]);
const owner = ref<string | null>(props.ticket.by_agent);
const busy = ref(false);

onMounted(async () => {
    if (!props.showEditButton) return; // only the editable context shows manage
    try {
        subState.value = (await api.ticketSubState(props.ticket.id)).state;
    } catch { /* leave null — control still works */ }
});

function openManage(event: MouseEvent) {
    managePopover.value?.show(event);
    if (agents.value.length === 0) {
        api.mentionSuggestions().then((s) => { agents.value = s.agents; }).catch(() => {});
    }
}

// #352 (owner inclu): muting silences this thread's pings even for a project
// owner — the server honours it over the owner-role fan-out.
async function toggleMute() {
    busy.value = true;
    try {
        const mute = subState.value !== "muted"; // toggle: not-muted → mute, muted → unmute(follow)
        await api.setTicketSub(props.ticket.id, mute);
        subState.value = mute ? "muted" : "followed";
    } catch { /* swallow — UI just won't reflect it */ } finally {
        busy.value = false;
    }
}

async function changeOwner(next: string | null) {
    if (!next || next === owner.value) return;
    busy.value = true;
    try {
        await api.changeTicketOwner(props.ticket.id, next);
        owner.value = next;
    } catch { /* swallow */ } finally {
        busy.value = false;
    }
}
</script>

<template>
    <h2 class="thread-title">{{ ticket.title }}</h2>
    <template v-if="showBanners">
        <div
            v-if="ticket.resolved && !ticket.closed"
            class="thread-resolved-banner"
            :title="ticket.resolved_at ?? ''"
        >
            <i class="pi pi-check-circle" />
            Marked resolved<span v-if="ticket.resolved_by"> by <strong>{{ ticket.resolved_by }}</strong></span>
            — the reporter can close to confirm.
        </div>
        <div
            v-else-if="ticket.resolved && ticket.closed"
            class="thread-resolved-banner thread-resolved-banner--closed"
            :title="ticket.resolved_at ?? ''"
        >
            <i class="pi pi-check-circle" />
            Resolved<span v-if="ticket.resolved_by"> by <strong>{{ ticket.resolved_by }}</strong></span>
            and closed.
        </div>
        <div
            v-else-if="ticket.closed && ticket.status !== 'rejected'"
            class="thread-closed-banner"
        >
            <i class="pi pi-lock" />
            Closed without explicit resolution (wontfix / abandoned / duplicate).
        </div>
        <div
            v-if="isSnoozed"
            class="thread-snoozed-banner"
            :title="ticket.postponed_until ?? ''"
        >
            <i class="pi pi-history" />
            Snoozed until
            <strong>
                {{ ticket.postponed_until
                    ? new Date(ticket.postponed_until).toLocaleString()
                    : "" }}
            </strong>
            — hidden from the open inbox until then.
        </div>
    </template>
    <div
        v-if="ticket.intent || (ticket.priority && ticket.priority !== 'normal') || (ticket.tags && ticket.tags.length) || showEditButton"
        class="thread-meta-extra"
    >
        <Tag
            v-if="ticket.intent"
            :value="ticket.intent"
            :severity="ticket.intent === 'panic' ? 'danger' : 'info'"
        />
        <Tag
            v-if="ticket.priority && ticket.priority !== 'normal'"
            :value="ticket.priority"
            :severity="ticket.priority === 'urgent' ? 'danger' : ticket.priority === 'high' ? 'warn' : 'info'"
        />
        <span
            v-for="t in ticket.tags ?? []"
            :key="t.id"
            class="thread-tag"
            :style="{ background: t.color ?? 'var(--p-surface-200)' }"
        >{{ t.name }}</span>
        <template v-if="showEditButton">
            <span class="spacer" />
            <Button
                v-if="!editing"
                icon="pi pi-pencil"
                label="edit message"
                size="small"
                severity="secondary"
                text
                @click="emit('start-edit')"
            />
            <!-- #352: single "manage" control (subscription + owner). -->
            <Button
                :icon="subState === 'muted' ? 'pi pi-bell-slash' : 'pi pi-cog'"
                label="manage"
                size="small"
                :severity="subState === 'muted' ? 'warn' : 'secondary'"
                text
                aria-label="manage subscription and owner"
                @click="openManage"
            />
            <Popover ref="managePopover">
                <div class="manage-panel">
                    <div class="manage-row">
                        <span class="manage-label">Notifications</span>
                        <Button
                            :icon="subState === 'muted' ? 'pi pi-bell-slash' : 'pi pi-bell'"
                            :label="subState === 'muted' ? 'Muted — click to unmute' : 'Mute this ticket'"
                            size="small"
                            :severity="subState === 'muted' ? 'warn' : 'secondary'"
                            :disabled="busy"
                            @click="toggleMute"
                        />
                        <small class="manage-hint">Mute silences this thread's pings — even if you're an owner.</small>
                    </div>
                    <div class="manage-row">
                        <span class="manage-label">Owner</span>
                        <Select
                            :model-value="owner"
                            :options="agents"
                            filter
                            placeholder="(reporter)"
                            :disabled="busy"
                            @update:model-value="changeOwner"
                        />
                        <small class="manage-hint">Reassign the ticket's reporter/owner.</small>
                    </div>
                </div>
            </Popover>
        </template>
    </div>
</template>

<style scoped>
.manage-panel {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 16rem;
    padding: 0.25rem;
}
.manage-row {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.manage-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--p-text-color);
}
.manage-hint {
    color: var(--p-text-muted-color);
    font-size: 0.72rem;
    line-height: 1.2;
}
</style>

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
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { TicketSummary } from "../lib/api";

defineProps<{
    ticket: TicketSummary;
    isSnoozed: boolean;
    showBanners?: boolean;
    showEditButton?: boolean;
    editing?: boolean;
}>();
const emit = defineEmits<{ (e: "start-edit"): void }>();
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
        </template>
    </div>
</template>

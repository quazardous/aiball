<script setup lang="ts">
/**
 * Ticket header — title, optional state banners (resolved / closed /
 * snoozed), intent + tags meta strip, optional "edit message" + "manage"
 * buttons. #B.196 Layer 3 extract from ThreadView.
 *
 * Two render contexts:
 *   - Bottom-up article: show banners + edit/manage buttons.
 *   - Top-down headline: title + meta-extra only.
 *
 * Presentational: the buttons just emit; the parent (ThreadView) owns the
 * inline edit panel (`editing`) and the inline manage panel (`managing`),
 * #352 — "manage" opens in-place like edit, not a popover.
 */
import Button from "primevue/button";
import Tag from "primevue/tag";
import type { TicketSummary } from "../lib/api";
import { estTokenCost, formatTokens } from "../lib/format";

defineProps<{
    ticket: TicketSummary;
    isSnoozed: boolean;
    showBanners?: boolean;
    showEditButton?: boolean;
    editing?: boolean;
    managing?: boolean;
}>();
const emit = defineEmits<{
    (e: "start-edit"): void;
    (e: "start-manage"): void;
}>();
</script>

<template>
    <!-- #382 : la priorité passe AU-DESSUS du titre (david). -->
    <Tag
        v-if="ticket.priority && ticket.priority !== 'normal'"
        class="thread-priority"
        :value="ticket.priority"
        :severity="ticket.priority === 'urgent' ? 'danger' : ticket.priority === 'high' ? 'warn' : 'info'"
    />
    <h2 class="thread-title">{{ ticket.title }}</h2>
    <!-- #405: hot-zone focus flag — the ticket the agent is actively working
         (most recent self-activity within the hot window). -->
    <span v-if="ticket.hot" class="thread-hot-focus" title="In your hot-zone — the ticket you're actively working (recent activity within the hot window).">
        🔥 focus
    </span>
    <!-- #404/#406: per-ticket token-effort cost (shown once any usage is
         captured; cost-equivalent — cache reads weighted 0.1×). -->
    <span
        v-if="estTokenCost(ticket.token_usage) > 0"
        class="thread-token-cost"
        :title="ticket.token_usage
            ? `tokens — in ${ticket.token_usage.tokens_in} · out ${ticket.token_usage.tokens_out} · cache write ${ticket.token_usage.cache_w} · cache read ${ticket.token_usage.cache_r}`
            : ''"
    >
        <i class="pi pi-bolt" /> {{ formatTokens(estTokenCost(ticket.token_usage)) }} tok
    </span>
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
    <!-- #362 : l'intent est remonté dans ThreadMetaHeader (cartouche du
         haut). #382 : la priorité est remontée au-dessus du titre ; cette
         bande ne porte plus que les tags (+ les boutons edit/manage). -->
    <div
        v-if="(ticket.tags && ticket.tags.length) || showEditButton"
        class="thread-meta-extra"
    >
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
            <!-- #352: opens an inline manage panel (subscriptions + owner),
                 in place like the edit panel — handled by ThreadView. -->
            <Button
                v-if="!managing"
                icon="pi pi-users"
                label="manage"
                size="small"
                severity="secondary"
                text
                @click="emit('start-manage')"
            />
        </template>
    </div>
</template>

<style scoped>
/* #406: per-ticket token-effort cost badge. */
.thread-token-cost {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin: 0.2rem 0 0.4rem;
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
    font-variant-numeric: tabular-nums;
}
.thread-token-cost .pi {
    font-size: 0.72rem;
    opacity: 0.7;
}
/* #405: hot-zone focus badge. */
.thread-hot-focus {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin: 0.2rem 0 0.3rem;
    padding: 0.05rem 0.45rem;
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 0.7rem;
    color: var(--p-orange-600, #c2410c);
    background: var(--p-orange-100, #ffedd5);
}
</style>

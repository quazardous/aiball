<script setup lang="ts">
/**
 * The thread's cartouche row — #B.NN copyable ref + project + status
 * + lifecycle badge + author + created date. Rendered in two places
 * in ThreadView (the article header AND the composer's #headline
 * slot when top-down is on), so factored out as its own SFC to drop
 * the duplication (#B.196 Layer 3 dedup).
 *
 * The ref tag flashes "copied #B.NN" after a copy — parent owns the
 * `justCopiedTicket` state + the 1.5s timeout (so a flash in the
 * article doesn't desync from the headline mirror). Child just
 * emits `copy`; keyboard Enter / Space behave like click for a11y.
 */
import Tag from "primevue/tag";
import type { TicketSummary } from "../lib/api";
import { STATUS_SEVERITY, type Severity } from "../lib/labels";
import { formatTicketRef } from "../lib/formatting";

defineProps<{
    ticket: TicketSummary;
    justCopied: boolean;
}>();

const emit = defineEmits<{
    (e: "copy"): void;
}>();

function statusSeverity(s: "pending" | "approved" | "rejected"): Severity {
    return STATUS_SEVERITY[s];
}
</script>

<template>
    <header class="meta">
        <Tag
            :value="justCopied ? `copied ${formatTicketRef(ticket.id)}` : formatTicketRef(ticket.id)"
            :severity="justCopied ? 'success' : 'secondary'"
            class="comment-ref-tag"
            role="button"
            tabindex="0"
            :title="`Click to copy this ticket's reference (${formatTicketRef(ticket.id)}) — paste it in any markdown body to link back here.`"
            @click="emit('copy')"
            @keydown.enter.prevent="emit('copy')"
            @keydown.space.prevent="emit('copy')"
        />
        <Tag :value="ticket.project" severity="info" />
        <!-- #362 : l'intent vit dans la cartouche du haut (avec projet
             + statut), plus dans la bande de tags sous le titre. -->
        <Tag
            v-if="ticket.intent"
            :value="ticket.intent"
            :severity="ticket.intent === 'panic' ? 'danger' : 'info'"
        />
        <Tag
            :value="ticket.status"
            :severity="statusSeverity(ticket.status)"
        />
        <!--
            Skip the lifecycle badge when the ticket itself is
            rejected — the `rejected` status tag rendered just above
            already conveys "this is over" with the right severity.
            Stacking "rejected" + "closed" would be redundant and
            misleading (it's not a wontfix close).
        -->
        <Tag
            v-if="ticket.status !== 'rejected' && ticket.closed && ticket.resolved"
            value="closed (resolved)"
            severity="success"
            icon="pi pi-check-circle"
        />
        <Tag
            v-else-if="ticket.status !== 'rejected' && ticket.closed"
            value="closed"
            severity="warn"
            icon="pi pi-lock"
        />
        <Tag
            v-else-if="ticket.resolved"
            value="resolved (pending close)"
            severity="success"
            icon="pi pi-check-circle"
        />
        <span v-if="ticket.by_agent">by {{ ticket.by_agent }}</span>
        <span class="spacer" />
        <span :title="ticket.created_at">
            {{ new Date(ticket.created_at).toLocaleString() }}
        </span>
    </header>
</template>

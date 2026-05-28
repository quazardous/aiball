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
import { estTokenEffort, formatTokens, tokenBreakdownTitle } from "../lib/format";

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

/**
 * #567 — tooltip de la chip "claim by". Quand l'assignee est la même
 * personne que le claimant (cas fréquent : l'agent claim son propre
 * assignment), on ne rend QU'UNE chip, mais le tooltip mentionne les
 * deux statuts pour ne pas perdre l'info — surtout `assigned_at` qui
 * indique l'ancienneté de la responsabilité (vs `claimed_at` =
 * dernier engage, transient).
 */
function claimerTooltip(t: TicketSummary): string {
    const parts = [`Claimed by ${t.claimant}`];
    if (t.claimed_at) parts.push(new Date(t.claimed_at).toLocaleString());
    if (t.assignee === t.claimant) {
        parts.push("(also the assignee)");
        if (t.assigned_at) parts.push(`assigned ${new Date(t.assigned_at).toLocaleString()}`);
    }
    return parts.join(" · ");
}
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
    <!-- #405/#408: hot-zone focus flag — the ticket an AGENT is actively working
         (most recent agent activity within the hot window). #408: a human
         commenting does NOT make a ticket hot; only an agent's work does. -->
    <span v-if="ticket.hot" class="thread-hot-focus" title="Hot-zone — an agent is actively working this ticket (recent agent activity within the hot window).">
        🔥 focus
    </span>
    <!-- #567 david : subline compacte (claimant / assignee / token cost) sur
         UNE seule ligne inline-flex, wrap si débord. Avant : 3 spans empilés
         (héritage `align-self: flex-start` + margins verticaux dans un flex
         column parent). David : « on peut rendre plus compact, si le assignee
         et le claimed sont pareil on mais que claim by » → quand
         `claimant === assignee`, on ne rend que la chip claim et son tooltip
         précise que l'assignment correspond. -->
    <!-- #418/#429: who currently holds this ticket. david (#429): "afficher qui
         a claim mais pas dans un badge" — DISCREET muted inline text, NOT a
         pill. Read-only here ; agents claim/release via MCP, a human moderator
         pushes via the manage panel.
         #436: claim (focus) and assignment (responsibility) are distinct now —
         a ticket can show both. -->
    <div
        v-if="ticket.claimant || ticket.assignee || estTokenEffort(ticket.token_usage) > 0"
        class="thread-subline"
    >
        <span
            v-if="ticket.claimant"
            class="thread-subline__item"
            :title="claimerTooltip(ticket)"
        >
            <i class="pi pi-bookmark-fill" /> claim by {{ ticket.claimant }}
        </span>
        <span
            v-if="ticket.assignee && ticket.assignee !== ticket.claimant"
            class="thread-subline__item"
            :title="`Assigned to ${ticket.assignee}${ticket.assigned_at ? ' · ' + new Date(ticket.assigned_at).toLocaleString() : ''}`"
        >
            <i class="pi pi-user-plus" /> assigned to {{ ticket.assignee }}
        </span>
        <!-- #404/#406: per-ticket token-effort cost (cost-equivalent — cache
             reads weighted 0.1×). Inline avec le reste de la subline (#567). -->
        <span
            v-if="estTokenEffort(ticket.token_usage) > 0"
            class="thread-subline__item"
            :title="tokenBreakdownTitle(ticket.token_usage)"
        >
            <i class="pi pi-bolt" /> {{ formatTokens(estTokenEffort(ticket.token_usage)) }} tok
        </span>
    </div>
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
/* #567 david : subline compacte regroupant claim / assignee / token cost
   sur UNE ligne (wrap si débord). Avant : 3 spans frères, chacun
   `display: inline-flex` mais avec `align-self: flex-start` + margin
   verticale dans un flex column parent → empilés. Le wrapper unique
   contourne ça + le `flex-wrap: wrap` garde une dégradation propre sur
   mobile. Discreet muted (pas un badge, david #429). */
.thread-subline {
    display: flex;
    flex-wrap: wrap;
    align-self: flex-start;
    align-items: center;
    gap: 0.3rem 0.9rem;
    margin: 0.2rem 0 0.4rem;
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
    font-variant-numeric: tabular-nums;
}
.thread-subline__item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.thread-subline__item .pi {
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

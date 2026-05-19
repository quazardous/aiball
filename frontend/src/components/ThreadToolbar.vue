<script setup lang="ts">
/**
 * Top action bar for a thread (#B.196 Layer 3 extract from ThreadView).
 * Same conceptual actions as ThreadActionsDock, but rendered as compact
 * rounded text buttons (icon-only) for the toolbar lane: back +
 * topDown toggle + broadcast + snooze/unsnooze + the state-conditional
 * action mini-buttons that mirror the dock's branches.
 *
 * Global topDown pref is imported directly (shared across all threads).
 * The snooze popover lives in the parent — the child forwards the
 * MouseEvent via `open-snooze` so the popover anchors correctly.
 */
import Button from "primevue/button";
import type { Message, TicketSummary } from "../lib/api";
import type { CommentDecision } from "../lib/decisions";
import { topDown, toggleTopDown } from "../lib/prefs";

defineProps<{
    ticket: TicketSummary;
    isSnoozed: boolean;
    hasBody: boolean;
    activeDecision: { message: Message; decision: CommentDecision } | null;
    pendingResolution: Message | null;
    snoozeBusy: boolean;
    resolutionBusy: boolean;
}>();

const emit = defineEmits<{
    (e: "back"): void;
    (e: "open-snooze", event: MouseEvent): void;
    (e: "unsnooze"): void;
    (e: "reject-active"): void;
    (e: "accept-active"): void;
    (e: "reject-resolution"): void;
    (e: "accept-resolution"): void;
    (e: "comment-mark-resolved"): void;
    (e: "comment-reopen"): void;
    (e: "comment-close"): void;
    (e: "comment-undo-reject"): void;
}>();
</script>

<template>
    <div class="thread-toolbar">
        <Button
            icon="pi pi-arrow-left"
            label="back"
            severity="secondary"
            text
            size="small"
            @click="emit('back')"
        />
        <span class="spacer" />
        <!-- #B.133: thread-order toggle. Button lives in the
             thread head (per david: "tu peux laisser le bouton
             dans le head du thread") but the state is shared
             globally via `lib/prefs.ts` — toggling here flips
             the order on every thread you open. -->
        <Button
            :icon="topDown ? 'pi pi-sort-amount-down' : 'pi pi-sort-amount-up'"
            severity="secondary"
            size="small"
            text
            rounded
            :title="topDown
                ? 'Thread order (applies to ALL threads): newest at top. Click to flip to oldest-first.'
                : 'Thread order (applies to ALL threads): oldest first (default). Click to flip to newest at top.'"
            @click="toggleTopDown"
        />
        <!-- #B.245 fgum2c: the broadcast/megaphone toggle is gone.
             Scope is per-event now — the composer's Select dropdown
             carries it, and each event renders its own per-scope
             picto in lists + cards. A ticket-wide flip no longer
             matches the model. -->
        <Button
            v-if="ticket.status !== 'rejected' && !ticket.closed && !isSnoozed"
            icon="pi pi-history"
            severity="info"
            size="small"
            text
            rounded
            :loading="snoozeBusy"
            title="Snooze this ticket — it disappears from the open inbox until the date you pick, then auto-reappears."
            @click="(ev) => emit('open-snooze', ev)"
        />
        <Button
            v-if="isSnoozed"
            icon="pi pi-bell"
            severity="info"
            size="small"
            :loading="snoozeBusy"
            :title="`Snoozed until ${ticket.postponed_until ? new Date(ticket.postponed_until).toLocaleString() : ''} — click to bring back now.`"
            @click="emit('unsnooze')"
        />
        <template v-if="ticket.status === 'approved' && !ticket.closed">
            <template v-if="activeDecision">
                <Button
                    icon="pi pi-times"
                    severity="secondary"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    :disabled="!hasBody"
                    :title="hasBody
                        ? `Reject the ${activeDecision.decision.kind} and post your note. Keeps the ticket open.`
                        : `Type an explanation in the composer first — rejecting needs a reason.`"
                    @click="emit('reject-active')"
                />
                <Button
                    icon="pi pi-verified"
                    severity="success"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    :title="activeDecision.decision.kind === 'resolution'
                        ? 'Accept the resolution and close. Embarks any text typed in the composer.'
                        : `Accept the ${activeDecision.decision.kind}. Embarks any text typed in the composer.`"
                    @click="emit('accept-active')"
                />
            </template>
            <template v-else-if="pendingResolution">
                <Button
                    icon="pi pi-times"
                    severity="secondary"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    :disabled="!hasBody"
                    :title="hasBody
                        ? 'Reject the resolution proposal and post your note. Keeps the ticket open.'
                        : 'Type an explanation in the composer first — rejecting needs a reason.'"
                    @click="emit('reject-resolution')"
                />
                <Button
                    icon="pi pi-verified"
                    severity="success"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    title="Accept the resolution and close. Embarks any text typed in the composer."
                    @click="emit('accept-resolution')"
                />
            </template>
            <template v-else>
                <Button
                    v-if="!ticket.resolved && !ticket.blocked"
                    icon="pi pi-check-circle"
                    severity="success"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    title="Mark resolved (soft proposal — reporter accepts to close). Plan-proposal is available in the composer split-button. Embarks any text typed in the composer."
                    @click="emit('comment-mark-resolved')"
                />
                <Button
                    v-if="ticket.resolved || ticket.blocked"
                    icon="pi pi-undo"
                    severity="warn"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    :title="ticket.blocked
                        ? 'Undo the TBD flag — bring the ticket back to plain open. Embarks any text typed in the composer.'
                        : 'Undo resolved — clear the resolution and bring the ticket back to plain open. Embarks any text typed in the composer.'"
                    @click="emit('comment-reopen')"
                />
                <Button
                    icon="pi pi-lock"
                    severity="secondary"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    title="Close the ticket (only the reporter can close). Embarks any text typed in the composer."
                    @click="emit('comment-close')"
                />
            </template>
        </template>
        <Button
            v-else-if="ticket.status === 'approved' && ticket.closed"
            icon="pi pi-unlock"
            severity="info"
            size="small"
            text
            rounded
            :loading="resolutionBusy"
            title="Reopen this ticket. Embarks any text typed in the composer."
            @click="emit('comment-reopen')"
        />
        <template v-else-if="ticket.status === 'pending' && ticket.resolved && !ticket.closed">
            <Button
                icon="pi pi-undo"
                severity="warn"
                size="small"
                text
                rounded
                :loading="resolutionBusy"
                title="Undo resolved — clear the resolution while the ticket is still in moderation. Embarks any text typed in the composer."
                @click="emit('comment-reopen')"
            />
            <Button
                icon="pi pi-lock"
                severity="secondary"
                size="small"
                text
                rounded
                :loading="resolutionBusy"
                title="Close the ticket (only the reporter can close). Embarks any text typed in the composer."
                @click="emit('comment-close')"
            />
        </template>
        <Button
            v-else-if="ticket.status === 'rejected'"
            icon="pi pi-replay"
            severity="warn"
            size="small"
            text
            rounded
            :loading="resolutionBusy"
            title="Undo reject — bring this ticket back to approved. Embarks any text typed in the composer."
            @click="emit('comment-undo-reject')"
        />
    </div>
</template>

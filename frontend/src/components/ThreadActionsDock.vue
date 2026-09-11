<script setup lang="ts">
/**
 * The thread's action surface (#B.196 Layer 3 extract from ThreadView's
 * `#extra-actions` slot inside MessageComposer). Six conditional
 * branches share one snooze button at the top:
 *
 *   status === pending    → reject + approve Buttons (moderation, gate
 *                            FIRST: nothing meaningful can happen on a
 *                            not-yet-approved ticket — #486)
 *   activeDecision        → reject + accept SplitButtons (#B.129/B.139)
 *   pendingResolution     → legacy reject + accept (pre-#B.129 rows)
 *   status === rejected   → undo reject Button
 *   ticket.closed         → reopen Button
 *   default (open)        → mark resolved SplitButton + (undo) + close
 *
 * State (composer body, busy flags, decisions, menus) stays in the
 * parent. The snooze popover ref also stays in the parent — the child
 * just forwards the MouseEvent via `open-snooze`.
 */
import Button from "primevue/button";
import SplitButton from "primevue/splitbutton";
import type { Message, TicketSummary } from "../lib/api";
import type { CommentDecision } from "../lib/decisions";

/**
 * #1835 — what accepting each decision kind actually DOES to the ticket.
 *
 * This was a nested ternary whose fallback read "keep open", so `wontfix` —
 * the only kind not named in it — promised the opposite of what happens:
 * accepting a wontfix auto-closes the ticket server-side. The dropdown beside
 * this button said "close without resolution" all along, so the two halves of
 * the same control disagreed.
 *
 * A total record instead of a fallback, deliberately: a fifth decision kind
 * would fail to compile here rather than inherit a sentence that happens to be
 * wrong about it. Twice today a switch narrower than the decision model failed
 * silently and toward "nothing to do".
 */
const ACCEPT_LABELS: Record<CommentDecision["kind"], string> = {
    resolution: "accept resolution → close",
    wontfix: "accept wontfix → close",
    escalation: "accept escalation → action done",
    plan: "accept plan → keep open",
};

function acceptLabel(kind: CommentDecision["kind"]): string {
    return ACCEPT_LABELS[kind];
}

interface MenuItem {
    label: string;
    icon: string;
    command: () => void;
}

defineProps<{
    ticket: TicketSummary;
    hasBody: boolean;
    activeDecision: { message: Message; decision: CommentDecision } | null;
    pendingResolution: Message | null;
    isSnoozed: boolean;
    resolutionBusy: boolean;
    decideBusy: boolean;
    snoozeBusy: boolean;
    acceptMenu: MenuItem[];
    rejectMenu: MenuItem[];
    legacyAcceptMenu: MenuItem[];
    decisionMenu: MenuItem[];
}>();

const emit = defineEmits<{
    (e: "open-snooze", event: MouseEvent): void;
    (e: "reject-active"): void;
    (e: "accept-active"): void;
    (e: "reject-resolution"): void;
    (e: "accept-resolution"): void;
    (e: "comment-undo-reject"): void;
    (e: "comment-reopen"): void;
    (e: "comment-close"): void;
    (e: "comment-mark-resolved"): void;
    (e: "decide", action: "approve" | "reject"): void;
}>();
</script>

<template>
    <!-- #B.143: snooze is "mental-load relief" (david's framing) —
         should be reachable regardless of which decision/state the
         thread is in. Lives here so every branch below inherits it. -->
    <Button
        v-if="!ticket.closed && ticket.status !== 'rejected' && !isSnoozed"
        icon="pi pi-history"
        :label="hasBody ? 'comment and snooze' : 'snooze'"
        severity="info"
        size="small"
        text
        :loading="snoozeBusy"
        title="Set aside — type your context first if you want, then pick a duration. The ticket disappears from the open inbox until then."
        @click="(ev) => emit('open-snooze', ev)"
    />
    <template v-if="ticket.status === 'pending'">
        <Button
            icon="pi pi-times"
            label="reject"
            severity="danger"
            size="small"
            outlined
            :loading="decideBusy"
            title="Reject this pending ticket. The author is notified; comments stay readable."
            @click="emit('decide', 'reject')"
        />
        <Button
            icon="pi pi-check"
            label="approve"
            severity="success"
            size="small"
            :loading="decideBusy"
            title="Approve this pending ticket so it joins the open inbox."
            @click="emit('decide', 'approve')"
        />
    </template>
    <template v-else-if="activeDecision">
        <SplitButton
            :label="`reject ${activeDecision.decision.kind}`"
            icon="pi pi-times"
            severity="secondary"
            size="small"
            outlined
            :loading="resolutionBusy"
            :disabled="!hasBody"
            :model="rejectMenu"
            menu-button-aria-label="Reject or reclassify as different decision kind"
            :title="hasBody
                ? `Reject the ${activeDecision.decision.kind} — ticket stays open. Your composer body is posted as the explanation.`
                : `Type an explanation in the composer first — rejecting a ${activeDecision.decision.kind} needs a reason.`"
            @click="emit('reject-active')"
        />
        <SplitButton
            :label="acceptLabel(activeDecision.decision.kind)"
            icon="pi pi-verified"
            severity="success"
            size="small"
            :loading="resolutionBusy"
            :model="acceptMenu"
            menu-button-aria-label="Accept as different decision kind"
            @click="emit('accept-active')"
        />
    </template>
    <template v-else-if="pendingResolution">
        <Button
            icon="pi pi-times"
            label="reject resolution"
            severity="secondary"
            size="small"
            outlined
            :loading="resolutionBusy"
            :disabled="!hasBody"
            :title="hasBody
                ? 'Reject the resolution proposal — ticket stays open. Your composer body is posted as the explanation.'
                : 'Type an explanation in the composer first — rejecting a proposal needs a reason.'"
            @click="emit('reject-resolution')"
        />
        <SplitButton
            label="accept resolution → close"
            icon="pi pi-verified"
            severity="success"
            size="small"
            :loading="resolutionBusy"
            :model="legacyAcceptMenu"
            menu-button-aria-label="Accept as different decision kind"
            @click="emit('accept-resolution')"
        />
    </template>
    <template v-else-if="ticket.status === 'rejected'">
        <Button
            icon="pi pi-replay"
            :label="hasBody ? 'comment and undo reject' : 'undo reject'"
            severity="warn"
            size="small"
            :loading="resolutionBusy"
            @click="emit('comment-undo-reject')"
        />
    </template>
    <template v-else-if="ticket.closed">
        <Button
            icon="pi pi-unlock"
            :label="hasBody ? 'comment and reopen' : 'reopen ticket'"
            severity="info"
            size="small"
            :loading="resolutionBusy"
            @click="emit('comment-reopen')"
        />
    </template>
    <template v-else>
        <!-- snooze button now lives at the top of #extra-actions
             (#B.143) so every state inherits it; no per-branch dupe -->
        <SplitButton
            v-if="!ticket.resolved && !ticket.blocked"
            :label="hasBody ? 'comment and mark resolved' : 'mark resolved'"
            icon="pi pi-check-circle"
            severity="success"
            size="small"
            text
            :loading="resolutionBusy"
            :model="decisionMenu"
            menu-button-aria-label="Other decision actions"
            @click="emit('comment-mark-resolved')"
        />
        <Button
            v-if="ticket.resolved || ticket.blocked"
            icon="pi pi-undo"
            :label="hasBody ? 'comment and undo' : 'undo'"
            severity="warn"
            size="small"
            :title="ticket.blocked
                ? 'Undo the TBD flag — bring the ticket back to plain open. Embarks any text typed in the composer.'
                : 'Undo resolved — clear the resolution and bring the ticket back to plain open. Embarks any text typed in the composer.'"
            :loading="resolutionBusy"
            @click="emit('comment-reopen')"
        />
        <Button
            icon="pi pi-lock"
            :label="hasBody ? 'comment and close' : 'close ticket'"
            severity="secondary"
            size="small"
            :loading="resolutionBusy"
            @click="emit('comment-close')"
        />
    </template>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Popover from "primevue/popover";
import { api, INTENTS, type Intent, type Priority, type Tag as TagType, type ThreadView as ThreadViewData } from "../lib/api";
import { topDown } from "../lib/prefs";
import ThreadRelations from "./ThreadRelations.vue";
import RelationKindMenu from "./RelationKindMenu.vue";
import ThreadHeader from "./ThreadHeader.vue";
import ThreadEditPanel from "./ThreadEditPanel.vue";
import ThreadCommentsList from "./ThreadCommentsList.vue";
import ThreadMetaHeader from "./ThreadMetaHeader.vue";
import ThreadActionsDock from "./ThreadActionsDock.vue";
import ThreadToolbar from "./ThreadToolbar.vue";
import { STAGE_LABELS, useThreadItems } from "../lib/threadItems";
import { bus, useBus } from "../lib/bus";
import { useSnooze } from "../lib/snooze";
import { useResolutionFlow } from "../lib/resolutionFlow";
import { useThreadRelations } from "../lib/threadRelations";
import { useEditPanel } from "../lib/editPanel";
import { useAutoMarkRead } from "../lib/autoMarkRead";
import MarkdownView from "./MarkdownView.vue";
import MessageComposer from "./MessageComposer.vue";

const props = defineProps<{ ticketId: number }>();
const emit = defineEmits<{ (e: "back"): void }>();

const data = ref<ThreadViewData | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const decideBusy = ref(false);

// Per-thread relation flow (#B.196 Layer 3) — add form + per-chip
// menu (popover ref / target / cached title) + add/change-kind/remove
// verbs + the bus listener that turns a right-click on `.ticket-ref`
// into the same menu. Lives in lib/threadRelations.ts; parent
// destructures with composable-side names aliased to the template's.
const {
    addRelationOpen,
    newRelationTarget,
    newRelationKind,
    addRelationBusy,
    relationKindOptions,
    submitNew: submitNewRelation,
    menuRef: relationMenuRef,
    menuTarget: relationMenuTarget,
    menuTargetTitle: relationMenuTargetTitle,
    openMenu: openRelationMenu,
    pickKind: pickRelationKind,
    deleteFromMenu: deleteFromRelationMenu,
} = useThreadRelations({ data, load });

async function load() {
    loading.value = true;
    error.value = null;
    try {
        data.value = await api.getTicket(props.ticketId);
        // If the API resolved a non-ticket id up to its parent thread, scroll
        // to the requested message after Vue has painted the comments.
        const focus = data.value?.focus_message_id ?? null;
        if (focus !== null) {
            requestAnimationFrame(() => {
                const el = document.getElementById(`comment-${focus}`);
                if (el) {
                    el.scrollIntoView({ behavior: "smooth", block: "center" });
                    el.classList.add("comment-card--focused");
                    setTimeout(() => el.classList.remove("comment-card--focused"), 2500);
                }
            });
        }
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.ticketId, (_, oldId) => {
    // #B.158: when the user clicks a ref the hover-popover (relation
    // promote menu) survives the navigation if we don't tear it down.
    // The Popover instance is component-scoped, so it stays open across
    // the route change; force-hide on every ticket switch.
    if (oldId !== undefined) {
        relationMenuRef.value?.hide();
        snoozePopoverRef.value?.hide();
        relationMenuTarget.value = null;
        relationMenuTargetTitle.value = null;
    }
    load();
});
onMounted(load);

// React to bus-driven refreshes (WS events, local actions in this or
// any sibling component). The thread reloads itself instead of being
// poked imperatively by the parent through a ref — the parent only has
// to emit on the bus and any open thread that matches reloads.
useBus("thread.refresh", ({ ticketId }) => {
    if (ticketId === props.ticketId) load();
});

// Auto-mark-as-read dwell timer (#B.91 / #B.191) — wired by the
// composable; no surface in this file.
useAutoMarkRead({ data, ticketId: () => props.ticketId });

/**
 * After any state-mutating action, emit on the bus so the open thread,
 * the inbox list, and the sidebar badges all refresh. The same event
 * also arrives from the server via WS shortly after, but emitting
 * locally makes the UI feel instant and keeps things responsive even
 * if the WS connection blips.
 */
function broadcastRefresh(ticketId: number) {
    bus.emit("thread.refresh", { ticketId });
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
}

async function decide(action: "approve" | "reject") {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    decideBusy.value = true;
    try {
        if (action === "approve") await api.approve(tid);
        else await api.reject(tid);
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        decideBusy.value = false;
    }
}

const editing = ref(false);
const intentBusy = ref(false);
const intentOptions = [
    { label: "(no intent)", value: null },
    ...INTENTS.map((p) => ({ label: p, value: p })),
];
async function changeIntent(v: Intent | null) {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    intentBusy.value = true;
    try {
        await api.edit(tid, { intent: v });
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        intentBusy.value = false;
    }
}
// #B.222: priority edit — parallel to intent. Owner-bypass server-side.
const priorityBusy = ref(false);
async function changePriority(v: Priority | null) {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    priorityBusy.value = true;
    try {
        await api.edit(tid, { priority: v });
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        priorityBusy.value = false;
    }
}
function onTagsChanged(tags: TagType[]) {
    if (data.value) data.value.ticket.tags = tags;
}

// Title + body edit (per #B.94): buffered drafts, save on explicit
// "save" button or Ctrl/Cmd+Enter, cancel reverts. Drafts persist
// to sessionStorage per ticket id so a page refresh mid-edit doesn't
// lose typing — when the panel reopens, the saved draft takes
// priority over the current DB values. Cleared on save (success)
// and on cancel.
// Edit-panel flow (#B.196 Layer 3) — title/body drafts +
// sessionStorage mirror + save/cancel verbs + the paste-image
// attach/detach on the body textarea. Intent + tags handlers stay
// here (they pair with the article header pickers, not just the
// edit panel). See lib/editPanel.ts.
const {
    titleDraft,
    bodyDraft,
    bodyBusy,
    editPanelRef,
    saveAndClose: saveAndCloseEdit,
    cancel: cancelEdit,
} = useEditPanel({
    data,
    ticketId: () => props.ticketId,
    editing,
    error,
    broadcastRefresh,
});

// Comments render flat under the ticket. Nested replies are no longer
// shown as a tree — to refer back to a specific comment, the reader
// copies its #N ref and pastes it (or quotes with `> ...`) into a fresh
// top-level comment. The data layer still tolerates parent_message_id
// for backward compatibility but the UI ignores it.
// View-derived computations live in lib/threadItems.ts: flatComments
// (chronological/top-down), decidersByMessage (60s decide→comment
// heuristic), latestSummaryUntil (latest tldr carrier), threadItems
// (relation group collapse + banner insertion), latestPendingId.
// STAGE_LABELS is re-exported from there for the sub-tickets recap
// below.
const {
    flatComments,
    decidersByMessage,
    latestSummaryUntil,
    threadItems,
    latestPendingId,
} = useThreadItems(data);

/**
 * Sub-tickets panel collapse state (per #B.62 reopen — accordion).
 * Auto-collapse when the list has more than 5 children so the header
 * stays compact; small lists stay open by default. The user can
 * always toggle via the chevron.
 */
const subTicketsExpanded = ref(false);
function onSubTicketsToggle(ev: Event) {
    subTicketsExpanded.value = (ev.target as HTMLDetailsElement).open;
}
const subTicketsPendingCount = computed(() =>
    (data.value?.ticket.sub_tickets ?? []).filter((s) => s.status === "pending").length,
);
const subTicketsClosedCount = computed(() =>
    (data.value?.ticket.sub_tickets ?? []).filter((s) => s.closed).length,
);

// Resolution / decision flow (#B.196 Layer 3) — composer body +
// busy flag + every accept/reject/close/reopen verb + the menus and
// activeDecision/pendingResolution derived computeds. Lives in
// lib/resolutionFlow.ts; the parent destructures and threads the
// pieces down to ThreadActionsDock + ThreadToolbar as props/emits.
const {
    composerBody,
    resolutionBusy,
    hasBody,
    postBodyAs,
    activeDecision,
    pendingResolution,
    acceptResolution,
    rejectResolution,
    commentAndMarkResolved,
    acceptActiveDecision,
    rejectActiveDecision,
    commentAndClose,
    commentAndReopen,
    commentAndUndoReject,
    acceptMenu,
    rejectMenu,
    legacyAcceptMenu,
    decisionMenu,
} = useResolutionFlow({ data, error, broadcastRefresh });


const broadcastBusy = ref(false);
// Snooze flow (#B.329) — popover ref + busy + the three "set aside"
// verbs (preset duration / custom datetime / unsnooze). Lives in
// lib/snooze.ts since the logic is self-contained around (data,
// composerBody, postBodyAs, error).
const {
    snoozeBusy,
    popoverRef: snoozePopoverRef,
    snoozeCustom,
    openSnoozePopover,
    snoozeFor,
    snoozeCustomSubmit,
    unsnooze,
    isSnoozed,
} = useSnooze({ data, composerBody, postBodyAs, error });

async function toggleBroadcast() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    broadcastBusy.value = true;
    try {
        const next = !data.value.ticket.broadcast;
        await api.setTicketBroadcast(tid, next);
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        broadcastBusy.value = false;
    }
}

const justCopiedTicket = ref(false);
async function copyTicketRef() {
    if (!data.value) return;
    const ref_ = `#B.${data.value.ticket.id}`;
    try {
        await navigator.clipboard.writeText(ref_);
        justCopiedTicket.value = true;
        setTimeout(() => (justCopiedTicket.value = false), 1500);
    } catch {
        /* clipboard write rejected — silent */
    }
}

</script>

<template>
    <div class="thread-view" :class="{ 'thread-view--top-down': topDown }">
        <ThreadToolbar
            v-if="data"
            :ticket="data.ticket"
            :is-snoozed="isSnoozed"
            :has-body="hasBody"
            :active-decision="activeDecision"
            :pending-resolution="pendingResolution"
            :broadcast-busy="broadcastBusy"
            :snooze-busy="snoozeBusy"
            :resolution-busy="resolutionBusy"
            @back="emit('back')"
            @toggle-broadcast="toggleBroadcast"
            @open-snooze="openSnoozePopover"
            @unsnooze="unsnooze"
            @reject-active="rejectActiveDecision"
            @accept-active="acceptActiveDecision()"
            @reject-resolution="rejectResolution"
            @accept-resolution="acceptResolution()"
            @comment-mark-resolved="commentAndMarkResolved"
            @comment-reopen="commentAndReopen"
            @comment-close="commentAndClose"
            @comment-undo-reject="commentAndUndoReject"
        />
        <Popover ref="snoozePopoverRef">
            <div class="snooze-popover">
                <div class="snooze-popover__title">Snooze until…</div>
                <div class="snooze-popover__presets">
                    <Button label="1 hour"  size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(60 * 60_000)" />
                    <Button label="3 hours" size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(3 * 60 * 60_000)" />
                    <Button label="tomorrow" size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(86_400_000)" />
                    <Button label="3 days" size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(3 * 86_400_000)" />
                    <Button label="1 week" size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(7 * 86_400_000)" />
                    <Button label="1 month" size="small" severity="secondary" :loading="snoozeBusy" @click="snoozeFor(30 * 86_400_000)" />
                </div>
                <div class="snooze-popover__custom">
                    <InputText
                        v-model="snoozeCustom"
                        size="small"
                        type="datetime-local"
                        class="snooze-popover__custom-input"
                        :disabled="snoozeBusy"
                    />
                    <Button
                        label="snooze"
                        icon="pi pi-check"
                        size="small"
                        severity="info"
                        :loading="snoozeBusy"
                        :disabled="!snoozeCustom"
                        @click="snoozeCustomSubmit"
                    />
                </div>
            </div>
        </Popover>

        <div v-if="error" class="aiball-empty" style="color: var(--p-red-500)">
            {{ error }}
        </div>
        <div v-else-if="!data && loading" class="aiball-empty">Loading…</div>
        <template v-else-if="data">
            <!-- #B.133 follow-up (david "ça devrait être dans le cadre de
                 la réponse en dropdown"): in top-down, the ticket
                 context (#B.NNN, tags, status, title, intent) is hosted
                 INSIDE the composer's frame via the #headline /
                 #headline-summary slots — collapsed by default. The
                 in-article copies stay in .thread-ticket (which sinks
                 to the bottom in top-down). No second lifted block. -->
            <article class="thread-ticket">
                <ThreadMetaHeader
                    :ticket="data.ticket"
                    :just-copied="justCopiedTicket"
                    @copy="copyTicketRef"
                />
                <div
                    v-if="data.ticket.parent_ticket_id"
                    class="thread-parent-ref"
                    title="This ticket is a sub-ticket — click to open the parent thread."
                >
                    <i class="pi pi-sitemap" />
                    <span>Sub-ticket of</span>
                    <a :href="`/b/${data.ticket.parent_ticket_id}`" class="thread-parent-ref__link">
                        #B.{{ data.ticket.parent_ticket_id }}
                    </a>
                </div>
                <details
                    v-if="data.ticket.sub_tickets && data.ticket.sub_tickets.length > 0"
                    class="thread-sub-tickets"
                    :open="subTicketsExpanded"
                    @toggle="onSubTicketsToggle"
                >
                    <summary class="thread-sub-tickets__header">
                        <i
                            class="pi thread-sub-tickets__chevron"
                            :class="subTicketsExpanded ? 'pi-chevron-down' : 'pi-chevron-right'"
                        />
                        <i class="pi pi-sitemap" />
                        <span>{{ data.ticket.sub_tickets.length }} sub-ticket{{ data.ticket.sub_tickets.length > 1 ? 's' : '' }}</span>
                        <!-- Surface counts inline so the user doesn't have to
                             expand just to see "how much pending?". -->
                        <span v-if="subTicketsPendingCount" class="thread-sub-tickets__hint">
                            · {{ subTicketsPendingCount }} pending
                        </span>
                        <span v-if="subTicketsClosedCount" class="thread-sub-tickets__hint">
                            · {{ subTicketsClosedCount }} closed
                        </span>
                    </summary>
                    <ul class="thread-sub-tickets__list">
                        <li
                            v-for="sub in data.ticket.sub_tickets"
                            :key="sub.id"
                            class="thread-sub-tickets__item"
                            :class="{
                                'thread-sub-tickets__item--closed': sub.stage === 'closed' || sub.stage === 'closed-resolved' || sub.stage === 'rejected',
                            }"
                        >
                            <a :href="`/b/${sub.id}`" class="thread-sub-tickets__id">#B.{{ sub.id }}</a>
                            <span class="thread-sub-tickets__title">{{ sub.title }}</span>
                            <span
                                v-if="sub.stage !== 'open' && STAGE_LABELS[sub.stage]"
                                class="thread-sub-tickets__tag"
                                :data-stage="sub.stage"
                            >{{ STAGE_LABELS[sub.stage] }}</span>
                        </li>
                    </ul>
                </details>
                <!-- #B.123 phase B.2 / #B.196 split: relations cartouche
                     extracted to ThreadRelations.vue. State is hoisted so
                     the top-down mirror instance below shares the same
                     form. The change-kind / remove popover stays here
                     (one ref, both instances trigger it via @open-menu). -->
                <ThreadRelations
                    :relations="data.ticket.relations ?? []"
                    v-model:form-open="addRelationOpen"
                    v-model:form-target="newRelationTarget"
                    v-model:form-kind="newRelationKind"
                    :busy="addRelationBusy"
                    :relation-kind-options="relationKindOptions"
                    @submit="submitNewRelation"
                    @open-menu="(payload) => openRelationMenu(payload.event, payload.relation)"
                />
                <ThreadHeader
                    :ticket="data.ticket"
                    :is-snoozed="isSnoozed"
                    show-banners
                    show-edit-button
                    :editing="editing"
                    @start-edit="editing = true"
                />
                <ThreadEditPanel
                    v-if="editing"
                    ref="editPanelRef"
                    :ticket="data.ticket"
                    v-model:title-draft="titleDraft"
                    v-model:body-draft="bodyDraft"
                    :body-busy="bodyBusy"
                    :intent-busy="intentBusy"
                    :intent-options="intentOptions"
                    :priority-busy="priorityBusy"
                    @save="saveAndCloseEdit"
                    @cancel="cancelEdit"
                    @intent-change="changeIntent"
                    @priority-change="changePriority"
                    @tags-changed="onTagsChanged"
                />
                <MarkdownView :source="data.ticket.body" :self-ticket-id="data.ticket.id" />
            </article>

            <!-- #B.130 follow-up: the TLDR banner used to sit between
                 the ticket body and the comments list. Now it's
                 inserted INSIDE the comments list right after the
                 comment that carries the latest summary_until — so
                 post-summary comments visually fall on the "not yet
                 summarized" side of the banner (david: "intercalé
                 entre le commentaire qu'il porte et les suivants non
                 encore pris en compte"). See threadItems builder. -->
            <ThreadCommentsList
                :items="threadItems"
                :is-empty="flatComments.length === 0"
                :latest-pending-id="latestPendingId"
                :deciders-by-message="decidersByMessage"
                :latest-summary-until="latestSummaryUntil"
                :stage-labels="STAGE_LABELS"
            />

            <MessageComposer
                v-model:body="composerBody"
                mode="comment"
                :project="data.ticket.project"
                :ticket-id="data.ticket.id"
                :parent-id="data.ticket.id"
                :placeholder="activeDecision
                    ? `${activeDecision.message.by_agent ?? 'someone'} tagged this as a ${activeDecision.decision.kind} — type WHY before rejecting, or pick an action below`
                    : pendingResolution
                        ? `${pendingResolution.by_agent ?? 'someone'} proposes this is resolved — type WHY before rejecting, or pick an action below`
                        : data.ticket.status === 'rejected'
                            ? 'This ticket was rejected — comment for context, or undo the rejection to bring it back'
                            : data.ticket.closed
                                ? 'This ticket is closed but still commentable — type a note, or reopen the thread to keep working'
                                : data.ticket.status === 'pending'
                                    ? 'Reply on this pending thread (markdown supported) — your comment goes through moderation unless you are human'
                                    : 'Reply on this thread (markdown supported, use > for quotes and #N to reference a comment)'"
            >
                <template v-if="topDown" #headline>
                    <ThreadMetaHeader
                        :ticket="data.ticket"
                        :just-copied="justCopiedTicket"
                        @copy="copyTicketRef"
                    />
                    <!-- Mirror cartouche for the top-down headline (same
                         component, hoisted state syncs the form across
                         both instances). #B.196 split. -->
                    <ThreadRelations
                        :relations="data.ticket.relations ?? []"
                        v-model:form-open="addRelationOpen"
                        v-model:form-target="newRelationTarget"
                        v-model:form-kind="newRelationKind"
                        :busy="addRelationBusy"
                        :relation-kind-options="relationKindOptions"
                        instance-key-prefix="hdr-"
                        @submit="submitNewRelation"
                        @open-menu="(payload) => openRelationMenu(payload.event, payload.relation)"
                    />
                    <ThreadHeader
                        :ticket="data.ticket"
                        :is-snoozed="isSnoozed"
                    />
                </template>
                <template #extra-actions>
                    <ThreadActionsDock
                        :ticket="data.ticket"
                        :has-body="hasBody"
                        :active-decision="activeDecision"
                        :pending-resolution="pendingResolution"
                        :is-snoozed="isSnoozed"
                        :resolution-busy="resolutionBusy"
                        :decide-busy="decideBusy"
                        :snooze-busy="snoozeBusy"
                        :accept-menu="acceptMenu"
                        :reject-menu="rejectMenu"
                        :legacy-accept-menu="legacyAcceptMenu"
                        :decision-menu="decisionMenu"
                        @open-snooze="openSnoozePopover"
                        @reject-active="rejectActiveDecision"
                        @accept-active="acceptActiveDecision()"
                        @reject-resolution="rejectResolution"
                        @accept-resolution="acceptResolution()"
                        @comment-undo-reject="commentAndUndoReject"
                        @comment-reopen="commentAndReopen"
                        @comment-close="commentAndClose"
                        @comment-mark-resolved="commentAndMarkResolved"
                        @decide="decide"
                    />
                </template>
            </MessageComposer>
        </template>
        <!-- #B.123 phase B.2.c / #B.196 split: change-kind / remove
             popover. Body is RelationKindMenu, Popover keeps the ref
             (shared trigger surface across both ThreadRelations
             instances + the ticket-ref bus listener). -->
        <Popover ref="relationMenuRef">
            <RelationKindMenu
                :target="relationMenuTarget"
                :target-title="relationMenuTargetTitle"
                :busy="addRelationBusy"
                @close="relationMenuRef?.hide()"
                @pick="(k) => pickRelationKind(k)"
                @remove="deleteFromRelationMenu"
            />
        </Popover>
    </div>
</template>

<!-- #B.196 Layer 3: CSS lives in the sibling file (component-owned but
     unscoped because child components — RelationChip, CommentNode,
     ThreadRelations — render the .thread-* classes the rules target,
     so scoping would orphan them). The future per-component splits
     should use `<style src="./X.css" scoped>` when classes aren't
     shared with children. -->
<style src="./ThreadView.css"></style>


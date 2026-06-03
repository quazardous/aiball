<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Popover from "primevue/popover";
import { api, INTENTS, type Intent, type Priority, type Tag as TagType, type ThreadView as ThreadViewData } from "../lib/api";
import { topDown } from "../lib/prefs";
import { formatTicketRef } from "../lib/formatting";
import ThreadRelations from "./ThreadRelations.vue";
import RelationKindMenu from "./RelationKindMenu.vue";
import ThreadHeader from "./ThreadHeader.vue";
import ThreadEditPanel from "./ThreadEditPanel.vue";
import ThreadManagePanel from "./ThreadManagePanel.vue";
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
// #740 david `a9rucr` — the composer hosts an assignee picker, but the
// approve / reject buttons live in `ThreadActionsDock` and used to
// ignore it (the composer only pushed the assignment on its own submit
// path). Bind it as a v-model so `decide()` can push the assignment
// right after the moderation action succeeds.
const composerAssignee = ref("");

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
// #617 — registered AFTER useResolutionFlow below so the handler can
// gate on resolutionBusy (avoid an intermediate render during a
// 2-step accept-and-close flow).

// Auto-mark-as-read dwell timer (#B.91 / #B.191). #596 — `markingRead`
// flips true during the dwell so ThreadHeader can render a pulsing dot.
const { markingRead: threadMarkingRead, dwellMs: markReadDwellMs } = useAutoMarkRead({
    data,
    ticketId: () => props.ticketId,
});

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
        // #270: embark whatever the user typed in the composer as a
        // comment, the same way every resolution verb does (resolutionFlow
        // "every handler embarks any typed text before the action"). The
        // moderation decide() handler used to fire api.approve/reject only
        // and silently drop the typed comment.
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
        }
        if (action === "approve") await api.approve(tid);
        else await api.reject(tid);
        // #740 — push the assignee picked in the composer best-effort
        // after the moderation action lands. Mirrors MessageComposer's
        // own post-submit assign at line ~285/320 (#514) so approving
        // from the buttons (no composer submit fired) honours the same
        // dropdown. Failure is non-fatal — the ticket is already
        // approved/rejected ; the user can retry from the Manage panel.
        if (composerAssignee.value.trim()) {
            try {
                await api.assignTicket(tid, composerAssignee.value.trim());
            } catch (e) {
                console.warn("[ThreadView] failed to assign on decide:", e);
            }
            composerAssignee.value = "";
        }
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        decideBusy.value = false;
    }
}

const editing = ref(false);
// #352: inline "manage subscriptions + owner" panel, mirrors `editing`.
const managing = ref(false);
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
// #553 david `3r3vjq` — ticket-level scope edit (à côté de priority dans
// le edit panel). Pilote le fan-out par défaut des events futurs sur ce
// ticket (le composer per-comment scope a été retiré par #8864778).
const scopeBusy = ref(false);
async function changeScope(v: "internal" | "default" | "broadcast") {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    scopeBusy.value = true;
    try {
        await api.edit(tid, { scope: v });
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        scopeBusy.value = false;
    }
}
// #294: move-to-project. Destinations are loaded lazily the first time
// the edit panel opens (watch below) so the Select can offer them.
const projectOptions = ref<{ label: string; value: string }[]>([]);
const moveBusy = ref(false);
async function loadProjectOptions() {
    if (projectOptions.value.length) return;
    try {
        const list = await api.listProjectsDetailed(
            localStorage.getItem("aiball.human_id") ?? "human",
        );
        projectOptions.value = list.map((p) => ({ label: p.name, value: p.name }));
    } catch {
        /* non-fatal — the Select just stays empty (row hidden) */
    }
}
async function changeProject(v: string) {
    if (!data.value || !v || v === data.value.ticket.project) return;
    const tid = data.value.ticket.id;
    moveBusy.value = true;
    try {
        await api.moveTicket(tid, v);
        // The ticket left this project; refresh inbox/sidebar + thread.
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        moveBusy.value = false;
    }
}
// #377: project move now lives in the manage panel, so load its options when
// the manage panel opens (was: on edit).
watch(managing, (v) => { if (v) void loadProjectOptions(); });
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
// STAGE_LABELS is re-exported from there and threaded down to
// ThreadCommentsList for relation-row stage badges.
const {
    flatComments,
    decidersByMessage,
    latestSummaryUntil,
    threadItems,
    latestPendingId,
} = useThreadItems(data);

// #271: the standalone parent-ref + sub-ticket accordion are gone —
// lineage now renders as read-only `child_of` / `parent_of` chips in the
// relations cartouche (ThreadRelations), so it stays in sync with every
// other relation instead of drifting as a parallel header widget.

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

// #617 — thread.refresh bus handler gated on resolutionBusy. While a
// multi-step verb (accept-resolution → close, accept-active → close,
// etc.) is mid-flight, the API does two round-trips ; a WS event
// landing between the two refreshes data into an intermediate state
// where the dock's v-else-if branches resolve to the "no decision /
// not closed yet" cell, briefly rendering then disappearing the
// dock's buttons. We defer the refresh until the busy flag clears,
// then fire one catch-up load via the watcher below.
const pendingRefreshDuringBusy = ref(false);
useBus("thread.refresh", ({ ticketId }) => {
    if (ticketId !== props.ticketId) return;
    if (resolutionBusy.value) {
        pendingRefreshDuringBusy.value = true;
        return;
    }
    load();
});
watch(resolutionBusy, (busy) => {
    if (busy) return;
    if (pendingRefreshDuringBusy.value) {
        pendingRefreshDuringBusy.value = false;
        load();
    }
});

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

const justCopiedTicket = ref(false);
async function copyTicketRef() {
    if (!data.value) return;
    const ref_ = formatTicketRef(data.value.ticket.id);
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
            :snooze-busy="snoozeBusy"
            :resolution-busy="resolutionBusy"
            @back="emit('back')"
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
                <!-- #271: the parent-ref ("Sub-ticket of #B.x") and the
                     sub-ticket accordion used to live here, fed by the
                     legacy parent_ticket_id FK — a second, drift-prone
                     view of the same lineage the relations cartouche
                     already shows. Both are gone; lineage now appears as
                     read-only `child_of` / `parent_of` chips below. -->
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
                    :managing="managing"
                    :marking-read="threadMarkingRead"
                    :mark-read-dwell-ms="markReadDwellMs"
                    @start-edit="editing = true"
                    @start-manage="managing = true"
                />
                <ThreadManagePanel
                    v-if="managing"
                    :ticket="data.ticket"
                    :project-options="projectOptions"
                    :move-busy="moveBusy"
                    @move-change="changeProject"
                    @close="managing = false"
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
                    :scope-busy="scopeBusy"
                    @save="saveAndCloseEdit"
                    @cancel="cancelEdit"
                    @scope-change="changeScope"
                    @intent-change="changeIntent"
                    @priority-change="changePriority"
                    @tags-changed="onTagsChanged"
                />
                <MarkdownView :source="data.ticket.body" :self-ticket-id="data.ticket.id" :project="data.ticket.project" />
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
                v-model:assignee="composerAssignee"
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
                        :marking-read="threadMarkingRead"
                        :mark-read-dwell-ms="markReadDwellMs"
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


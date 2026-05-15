<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import Tag from "primevue/tag";
import Textarea from "primevue/textarea";
import { useToast } from "primevue/usetoast";
import MarkdownView from "./MarkdownView.vue";
import { api, type Message } from "../lib/api";
import { bus } from "../lib/bus";
import { attachPasteImage } from "../lib/pasteImage";
import { questionStats as computeQuestionStats } from "../lib/questions";
import { readDecision } from "../lib/decisions";

const props = defineProps<{
    msg: Message;
    /**
     * The latest pending comment in the thread is the only one that shows
     * the "pending" tag — older pending entries are visible but unobtrusive
     * so the eye lands on the most recent moderation request.
     */
    showPendingTag?: boolean;
}>();
/**
 * Refresh fan-out after a state-mutating action on this comment. We
 * emit on the bus rather than firing a Vue `submitted` event up to the
 * parent — anything that needs to react (the open thread, the inbox
 * list, the sidebar badges) subscribes directly. The server also
 * broadcasts the same change on WS, so the local emit is for instant
 * UX feedback before the WS round-trip lands.
 */
function broadcastRefresh() {
    if (props.msg.ticket_id !== null && props.msg.ticket_id !== undefined) {
        bus.emit("thread.refresh", { ticketId: props.msg.ticket_id });
    }
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
}

const decideBusy = ref(false);
async function decide(action: "approve" | "reject") {
    decideBusy.value = true;
    try {
        if (action === "approve") await api.approve(props.msg.id);
        else await api.reject(props.msg.id);
        broadcastRefresh();
    } finally {
        decideBusy.value = false;
    }
}

const justCopied = ref(false);
const commentRef = computed(() => {
    // Prefer the hashid if available (canonical since 0003 migration).
    // Fall back to the integer id for any legacy row that somehow lacks
    // a hashid — the backend's /b/:ref still resolves both forms.
    const h = props.msg.hashid;
    return h ? `#C.${h}` : `#C.${props.msg.id}`;
});

// #B.104: chip "X/Y answered" on the card. Computed off the rendered
// body (edited overrides original) — derives total / answered / open
// from the `- [ ]` vs `- [x]` characters; markers are not needed at
// the count level. Updates reactively when the body changes server-side.
const questionStats = computed(() =>
    computeQuestionStats(props.msg.edited_body ?? props.msg.body ?? ""),
);

// #B.129 phase 4: decision-on-comment audit chip. Read-only — the
// accept/reject pair lives under the composer, per david's layout
// constraint ("on change pas le layout actuel").
const decision = computed(() => readDecision(props.msg));
const decisionChipLabel = computed(() => {
    const d = decision.value;
    if (!d) return "";
    if (d.status === "pending") return `pending ${d.kind}`;
    const prefix = d.status === "accepted" ? "✓ accepted" : "✗ rejected";
    const by = d.decided_by ? ` by ${d.decided_by}` : "";
    return `${prefix} ${d.kind}${by}`;
});
const decisionChipSeverity = computed(() => {
    const d = decision.value;
    if (!d) return "secondary";
    if (d.status === "accepted") return "success";
    if (d.status === "rejected") return "danger";
    return "warn"; // pending
});

// #B.130: rolling summary (`meta.summary_until`). Surfaced as a tiny
// chip in the header for audit. The CANONICAL view of "current state"
// lives at the THREAD level (ThreadView shows the latest one as a
// banner above the comments) — per david: "c'est toujours le dernier
// summary_until qui a raison, les autres sont invisible perdu". Per-
// comment banners removed; the chip alone signals "this comment has
// a summary on record".
const summary = computed(() => {
    if (!props.msg.meta) return null;
    try {
        const m = JSON.parse(props.msg.meta) as { summary_until?: string };
        return typeof m.summary_until === "string" && m.summary_until ? m.summary_until : null;
    } catch {
        return null;
    }
});
async function copyRef() {
    try {
        await navigator.clipboard.writeText(commentRef.value);
        justCopied.value = true;
        setTimeout(() => (justCopied.value = false), 1500);
    } catch {
        /* clipboard write rejected (focus / permissions) — silent */
    }
}

interface LifecycleLabel {
    icon: string;
    verb: string;
    severity: "success" | "warn" | "info" | "secondary";
    /** When set, render the `source_ticket_id` of the message as a
     *  clickable ref after the verb. */
    showSource?: boolean;
}

const LIFECYCLE_LABELS: Record<string, LifecycleLabel> = {
    ticket_closed: { icon: "pi pi-lock", verb: "closed this ticket", severity: "warn" },
    ticket_reopened: { icon: "pi pi-unlock", verb: "reopened this ticket", severity: "info" },
    ticket_resolved: { icon: "pi pi-check-circle", verb: "marked this ticket resolved", severity: "success" },
    ticket_blocked: { icon: "pi pi-ban", verb: "flagged this ticket TBD (handing back to a human)", severity: "warn" },
    ticket_sub_added: { icon: "pi pi-sitemap", verb: "added sub-ticket", severity: "info", showSource: true },
    ticket_referenced: { icon: "pi pi-link", verb: "referenced this ticket from", severity: "secondary", showSource: true },
};

// Body edit (per #B.94). Toggle reveals a textarea seeded with the
// current body. The draft is persisted to `sessionStorage` on each
// keystroke so a page refresh mid-edit doesn't drop the typing —
// when the user clicks `edit` again, the saved draft takes priority
// over the current body. The draft is cleared on save (success) and
// on cancel. Cleanup-on-id-change: when the underlying message id
// rotates (which only happens if the parent reuses the slot, e.g.
// thread reload), we DON'T touch the storage for the previous id.
const editing = ref(false);
const bodyDraft = ref("");
const saveBusy = ref(false);

const draftKey = computed(() => `aiball.draft.comment.${props.msg.id}`);

function startEdit() {
    const saved = sessionStorage.getItem(draftKey.value);
    bodyDraft.value = saved !== null
        ? saved
        : (props.msg.edited_body ?? props.msg.body ?? "");
    editing.value = true;
}
function cancelEdit() {
    sessionStorage.removeItem(draftKey.value);
    editing.value = false;
}
async function saveEdit() {
    const current = props.msg.edited_body ?? props.msg.body ?? "";
    if (bodyDraft.value === current) {
        sessionStorage.removeItem(draftKey.value);
        editing.value = false;
        return;
    }
    saveBusy.value = true;
    try {
        await api.edit(props.msg.id, { body: bodyDraft.value });
        sessionStorage.removeItem(draftKey.value);
        editing.value = false;
        broadcastRefresh();
    } finally {
        saveBusy.value = false;
    }
}

// Mirror the draft into sessionStorage on every change while the
// edit panel is open. Skip when not editing so we don't write while
// the panel is closed.
watch(bodyDraft, (v) => {
    if (!editing.value) return;
    sessionStorage.setItem(draftKey.value, v);
});

// Paste-image on the edit textarea (per #B.76). The textarea is
// mounted/unmounted by `v-if="editing"`, so we hook the listener
// whenever it appears.
const editTextareaRef = ref<{ $el?: HTMLTextAreaElement } | null>(null);
const toast = useToast();
let detachPaste: (() => void) | null = null;

watch(editTextareaRef, (instance) => {
    detachPaste?.();
    detachPaste = null;
    const el = instance?.$el;
    if (!el) return;
    detachPaste = attachPasteImage(el, bodyDraft, {
        onError(err) {
            toast.add({
                severity: "error",
                summary: "Image paste failed",
                detail: err.message,
                life: 5000,
            });
        },
    });
});
onBeforeUnmount(() => detachPaste?.());
</script>

<template>
    <div
        class="comment-card"
        :class="{ 'comment-card--pending': msg.status === 'pending' }"
        :id="`comment-${msg.id}`"
    >
        <header class="meta">
            <Tag
                v-if="msg.status === 'pending' && showPendingTag"
                value="pending"
                severity="warn"
            />
            <span
                v-else-if="msg.status === 'pending'"
                class="pending-marker"
                title="awaiting moderation"
            >
                ·
            </span>
            <span v-if="msg.by_agent">by {{ msg.by_agent }}</span>
            <Tag
                v-if="questionStats.total > 0"
                :value="`${questionStats.answered}/${questionStats.total} answered`"
                :severity="questionStats.open === 0 ? 'success' : 'warn'"
                :title="questionStats.open === 0
                    ? 'All questions in this comment have been answered.'
                    : `${questionStats.open} question${questionStats.open === 1 ? '' : 's'} still open — click a checkbox to quote it in your reply.`"
                style="font-size: 0.7rem; margin-left: 0.4rem"
            />
            <!-- #B.129 phase 4: decision audit chip (read-only on the card;
                 accept/reject lives under the composer). -->
            <Tag
                v-if="decision"
                :value="decisionChipLabel"
                :severity="decisionChipSeverity"
                :title="decision.status === 'pending'
                    ? `${msg.by_agent ?? 'someone'} tagged this comment as a ${decision.kind} — accept/reject pair is under the composer.`
                    : `${decision.kind} ${decision.status}${decision.decided_at ? ' at ' + new Date(decision.decided_at).toLocaleString() : ''}`"
                style="font-size: 0.7rem; margin-left: 0.4rem"
            />
            <!-- #B.130 phase 1: one-line TLDR chip (kept in the
                 header for compact glance). A more prominent banner
                 above the body is rendered below. -->
            <Tag
                v-if="summary"
                value="📝"
                severity="info"
                :title="`Summary (author's TLDR): ${summary}`"
                style="font-size: 0.7rem; margin-left: 0.4rem; font-style: italic"
            />
            <span class="spacer" />
            <span
                class="comment-date-copy"
                role="button"
                tabindex="0"
                :title="justCopied ? `copied ${commentRef}` : `Click to copy this comment's reference (${commentRef}) — ${msg.created_at}`"
                @click="copyRef"
                @keydown.enter.prevent="copyRef"
                @keydown.space.prevent="copyRef"
            >
                <i v-if="justCopied" class="pi pi-check comment-date-copy-icon" />
                {{ justCopied ? `copied ${commentRef}` : new Date(msg.created_at).toLocaleString() }}
            </span>
        </header>
        <div
            v-if="LIFECYCLE_LABELS[msg.kind]"
            class="comment-lifecycle"
            :data-kind="msg.kind"
        >
            <i :class="LIFECYCLE_LABELS[msg.kind].icon" />
            <span>{{ LIFECYCLE_LABELS[msg.kind].verb }}</span>
            <a
                v-if="LIFECYCLE_LABELS[msg.kind].showSource && msg.source_ticket_id"
                :href="`/b/${msg.source_ticket_id}`"
                class="comment-lifecycle__ref"
            >#B.{{ msg.source_ticket_id }}</a>
        </div>
        <div v-if="editing" class="comment-edit">
            <Textarea
                ref="editTextareaRef"
                v-model="bodyDraft"
                :rows="4"
                autoResize
                style="width: 100%; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.9rem;"
                :disabled="saveBusy"
                placeholder="Comment body (markdown supported, leave blank to clear)"
                @keydown.ctrl.enter.prevent="saveEdit"
                @keydown.meta.enter.prevent="saveEdit"
                @keydown.escape.prevent="cancelEdit"
            />
            <div class="comment-edit-actions">
                <Button
                    label="save"
                    icon="pi pi-check"
                    size="small"
                    severity="success"
                    :loading="saveBusy"
                    @click="saveEdit"
                />
                <Button
                    label="cancel"
                    icon="pi pi-times"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="saveBusy"
                    @click="cancelEdit"
                />
            </div>
        </div>
        <MarkdownView
            v-if="!editing && (msg.body || msg.edited_body)"
            :source="msg.edited_body ?? msg.body"
            :message-id="msg.id"
            :questions-clickable="true"
        />
        <div v-if="msg.human_note" class="comment-note">
            <i class="pi pi-comment" />
            <em>{{ msg.human_note }}</em>
        </div>
        <div
            v-if="msg.status === 'pending' && msg.kind === 'comment_added'"
            class="comment-actions"
        >
            <Button
                label="approve"
                icon="pi pi-check"
                severity="success"
                size="small"
                :loading="decideBusy"
                @click="decide('approve')"
            />
            <Button
                label="reject"
                icon="pi pi-times"
                severity="danger"
                size="small"
                :loading="decideBusy"
                @click="decide('reject')"
            />
        </div>
        <div
            v-if="!editing && msg.kind === 'comment_added'"
            class="comment-actions"
        >
            <Button
                label="edit"
                icon="pi pi-pencil"
                size="small"
                severity="secondary"
                text
                @click="startEdit"
            />
        </div>
    </div>
</template>

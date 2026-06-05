<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Button from "primevue/button";
import SplitButton from "primevue/splitbutton";
import Tag from "primevue/tag";
import Textarea from "primevue/textarea";
import { useToast } from "primevue/usetoast";
import { useConfirm } from "primevue/useconfirm";
import MarkdownView from "./MarkdownView.vue";
import { api, type Message } from "../lib/api";
import { bus } from "../lib/bus";
import { attachPasteImage } from "../lib/pasteImage";
import { questionStats as computeQuestionStats } from "../lib/questions";
import { readDecision } from "../lib/decisions";
import { formatTicketRef } from "../lib/formatting";

interface DeciderInfo {
    action: "accepted" | "rejected";
    target_id: number;
    target_hashid: string | null;
    target_kind: string;
}
const props = defineProps<{
    msg: Message;
    /**
     * The latest pending comment in the thread is the only one that shows
     * the "pending" tag — older pending entries are visible but unobtrusive
     * so the eye lands on the most recent moderation request.
     */
    showPendingTag?: boolean;
    /**
     * #B.129 follow-up: when this comment is the one that triggered an
     * accept/reject act on a PRIOR comment, ThreadView passes the
     * decider info so we render a small "↪ accepted/rejected #C.XXX"
     * chip. Null when not a decider comment.
     */
    decider?: DeciderInfo | null;
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
const voteBusy = ref(false);

// #518 (david `uzwfc3` option A) — vote state pour ce comment. Lit
// `votes_summary` injecté par le backend (par viewer-aware request) ;
// fallback à un calcul local quand le payload n'a pas le champ (cas
// d'un WS broadcast cross-user où le `mine` du sender n'est pas le tien).
const myConsumerId = computed<string>(() => localStorage.getItem("aiball.human_id") ?? "");
const votesSummary = computed(() => {
    if (props.msg.votes_summary) return props.msg.votes_summary;
    // Fallback : recompute depuis meta.votes (présent dans le payload même
    // sur les broadcasts WS). Meta est typé loose côté front, on parse.
    type LooseMeta = { votes?: Record<string, 1 | -1> };
    const raw = (props.msg as unknown as { meta?: LooseMeta | string | null }).meta;
    let parsed: LooseMeta = {};
    if (typeof raw === "string" && raw) {
        try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
    } else if (raw && typeof raw === "object") {
        parsed = raw;
    }
    const votes = parsed.votes ?? {};
    let up = 0;
    let down = 0;
    let mine: 1 | -1 | null = null;
    for (const [voter, v] of Object.entries(votes)) {
        if (v === 1) up += 1;
        else if (v === -1) down += 1;
        if (voter === myConsumerId.value) mine = v;
    }
    return { up, down, mine };
});

async function vote(direction: 1 | -1) {
    if (voteBusy.value) return;
    voteBusy.value = true;
    try {
        // Toggle : si on a déjà voté pareil, on retract (value=0). Sinon on
        // pose le vote (flip d'une opposite ou nouveau vote).
        const value: 1 | -1 | 0 = votesSummary.value.mine === direction ? 0 : direction;
        await api.voteOnMessage(props.msg.id, value);
        broadcastRefresh();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Vote failed",
            detail: e instanceof Error ? e.message : String(e),
            life: 4000,
        });
    } finally {
        voteBusy.value = false;
    }
}
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
    if (d.status === "pending") {
        // #737 — pending escalation reads as the standalone "ESCALATED"
        // banner per david's plan : it's not "pending escalation" as if
        // we're waiting on the kind to be decided ; it's a flag that
        // human action is required. Plan/resolution/wontfix keep the
        // "pending $kind" framing (= proposal awaiting reporter accept).
        return d.kind === "escalation" ? "ESCALATED" : `pending ${d.kind}`;
    }
    const prefix = d.status === "accepted" ? "✓ accepted" : "✗ rejected";
    const by = d.decided_by ? ` by ${d.decided_by}` : "";
    return `${prefix} ${d.kind}${by}`;
});
const decisionChipSeverity = computed(() => {
    const d = decision.value;
    if (!d) return "secondary";
    if (d.status === "accepted") return "success";
    if (d.status === "rejected") return "danger";
    // #737 — pending escalation = visually arresting red ("I need a human
    // NOW") rather than the neutral warn yellow used for plan/resolution/
    // wontfix. The kind tells the human what's pending ; the color tells
    // them the urgency.
    if (d.kind === "escalation") return "danger";
    return "warn"; // pending plan/resolution/wontfix
});

// #B.256: post-hoc "classify" affordance — transform a plain comment
// into a plan/resolution decision, flip its kind, or untag it. Mirrors
// the backend `promoteToDecision` polymorphism (create when absent,
// reclassify/apply when pending). Hidden once the decision is terminal
// (accepted/rejected): re-tagging then 409s and the audit row must
// persist; posting a fresh comment is the escape. David #x5g34g
// (available with a pending decision too), #dzm3ef (untag), #nkcnfq
// (pi-refresh icon = "transform", not "tag").
const canClassify = computed(
    () =>
        props.msg.kind === "comment_added"
        && (!decision.value || decision.value.status === "pending"),
);
const classifyBusy = ref(false);
async function promote(kind: "plan" | "resolution", status?: "accepted" | "rejected") {
    classifyBusy.value = true;
    try {
        await api.promoteMessage(props.msg.id, kind, status);
        broadcastRefresh();
    } finally {
        classifyBusy.value = false;
    }
}
async function untag() {
    classifyBusy.value = true;
    try {
        await api.untagMessage(props.msg.id);
        broadcastRefresh();
    } finally {
        classifyBusy.value = false;
    }
}
// #B.256 / #266 yzfvud: the classify SplitButton adapts to the current
// decision. `classifyActions[0]` is the primary (button), the rest is the
// chevron menu. We DROP "tag as pending <kind>" for the kind this comment
// is ALREADY tagged as (a pending plan re-offering "tag as pending plan"
// is a no-op that confused the reader — david #266).
const classifyActions = computed(() => {
    const d = decision.value;
    const pendingKind = d?.status === "pending" ? d.kind : null;
    const items: { label: string; icon: string; command: () => void }[] = [];
    if (pendingKind !== "plan") {
        items.push({ label: "tag as pending plan", icon: "pi pi-refresh", command: () => { void promote("plan"); } });
    }
    if (pendingKind !== "resolution") {
        items.push({ label: "tag as pending resolution", icon: "pi pi-tag", command: () => { void promote("resolution"); } });
    }
    items.push({ label: "tag + accept as plan", icon: "pi pi-check", command: () => { void promote("plan", "accepted"); } });
    items.push({ label: "tag + accept as resolution", icon: "pi pi-check", command: () => { void promote("resolution", "accepted"); } });
    // #B.256 dzm3ef: offer "remove tag" only on a pending decision —
    // terminal ones are not un-taggable (backend 409s).
    if (d && d.status === "pending") {
        items.push({ label: "remove tag", icon: "pi pi-trash", command: () => { void untag(); } });
    }
    return items;
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

// #827 — resurface flash state. After a successful POST, swap the 🛎️
// for a ✓ for ~1.5s + show the resurfaced count in the tooltip.
const resurfaceDone = ref(false);
const resurfaceCount = ref(0);
async function resurfaceMessage() {
    try {
        const r = await api.resurface(props.msg.id);
        resurfaceCount.value = r.resurfaced;
        resurfaceDone.value = true;
        setTimeout(() => { resurfaceDone.value = false; }, 1500);
    } catch {
        /* 403 (non-human) / network — silent ; tooltip stays on the bell */
    }
}

interface LifecycleLabel {
    icon: string;
    verb: string;
    severity: "success" | "warn" | "info" | "secondary" | "danger";
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
    // #830 — decision events render as lifecycle-style chips (no body).
    // Verb names the action ("accepted X's plan") so the thread audit
    // reads naturally without re-fetching the original proposal.
    plan_accepted: { icon: "pi pi-check", verb: "accepted the plan", severity: "success" },
    plan_rejected: { icon: "pi pi-times", verb: "rejected the plan", severity: "danger" },
    resolution_accepted: { icon: "pi pi-check", verb: "accepted the resolution", severity: "success" },
    resolution_rejected: { icon: "pi pi-times", verb: "rejected the resolution", severity: "danger" },
    wontfix_accepted: { icon: "pi pi-check", verb: "accepted the wontfix", severity: "success" },
    wontfix_rejected: { icon: "pi pi-times", verb: "rejected the wontfix", severity: "danger" },
    escalation_accepted: { icon: "pi pi-check", verb: "accepted the escalation (action done)", severity: "success" },
    escalation_rejected: { icon: "pi pi-times", verb: "rejected the escalation", severity: "danger" },
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

// #309: delete a comment (human moderator only — the backend enforces it).
// The thread builder ships deleted comments (with ?include_deleted=1) body-
// stripped + carrying meta.deleted, so we render a tombstone and hide the
// body/actions. Deletion goes through a confirm dialog ("avec confirmation").
const deleted = computed<{ by: string; at: string } | null>(() => {
    try {
        return (JSON.parse(props.msg.meta ?? "{}") as { deleted?: { by: string; at: string } }).deleted ?? null;
    } catch {
        return null;
    }
});
const confirm = useConfirm();
const deleteBusy = ref(false);
function confirmDelete() {
    confirm.require({
        header: "Delete comment",
        message: "Delete this comment? It will be removed from the thread (agents won't see it).",
        icon: "pi pi-trash",
        acceptLabel: "Delete",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doDelete(); },
    });
}
async function doDelete() {
    deleteBusy.value = true;
    try {
        await api.deleteComment(props.msg.id);
        broadcastRefresh();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Delete failed",
            detail: (e as Error).message,
            life: 5000,
        });
    } finally {
        deleteBusy.value = false;
    }
}
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
            <!-- #B.129 follow-up: small chip when this comment was the
                 act that accepted/rejected a prior comment's decision.
                 Heuristic match in ThreadView (same author + decided_at
                 within 60s of this comment's created_at). -->
            <Tag
                v-if="decider && !decision"
                :icon="decider.action === 'accepted' ? 'pi pi-check' : 'pi pi-times'"
                :severity="decider.action === 'accepted' ? 'success' : 'danger'"
                :value="`${decider.action} ${decider.target_kind}`"
                :title="`This comment ${decider.action} the ${decider.target_kind} on ${decider.target_hashid ? '#C.' + decider.target_hashid : 'a prior comment'}`"
                style="font-size: 0.7rem; margin-left: 0.4rem"
            />
            <!-- #B.130 follow-up: TLDR is now rendered as an inline
                 frame below the body (or above in top-down) — see
                 .comment-summary further down. No more header chip
                 with tooltip — david: "au lieu d'un popup ce bouton
                 devrait afficher un cadre dans le commentaire". -->
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
            >{{ formatTicketRef(msg.source_ticket_id) }}</a>
        </div>
        <!-- #309: tombstone for a user-deleted comment (body is stripped
             server-side; meta.deleted carries who/when). -->
        <div v-if="deleted" class="comment-tombstone">
            <i class="pi pi-trash" />
            <em>comment deleted<span v-if="deleted.by"> by {{ deleted.by }}</span></em>
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
            :self-ticket-id="msg.ticket_id ?? undefined"
            :project="msg.project"
        />
        <div v-if="msg.human_note" class="comment-note">
            <i class="pi pi-comment" />
            <em>{{ msg.human_note }}</em>
        </div>
        <!-- #B.130 follow-up: per-comment TLDR frame removed (david:
             "si le dernier comment until est maintenant ok, pas besoin
             d'afficher les encarts jaunâtres"). The thread-level
             banner displays the latest summary_until as the canonical
             state — older ones are invisible-by-design. -->
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
            v-if="!editing && msg.kind === 'comment_added' && !deleted"
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
            <!-- #309: delete a comment (human moderator only — backend
                 enforced) with a confirm dialog. -->
            <Button
                label="delete"
                icon="pi pi-trash"
                size="small"
                severity="danger"
                text
                :loading="deleteBusy"
                @click="confirmDelete"
            />
            <!-- #B.256: classify dropdown next to the edit pencil —
                 transform this comment into a plan/resolution decision.
                 pi-refresh = "transform" (david #nkcnfq); chevron menu
                 carries the variants + "remove tag" when pending. -->
            <SplitButton
                v-if="canClassify"
                :label="classifyActions[0].label"
                icon="pi pi-refresh"
                size="small"
                severity="secondary"
                text
                :model="classifyActions.slice(1)"
                :loading="classifyBusy"
                @click="classifyActions[0].command()"
            />
            <!-- #518 (david `uzwfc3` option A + `7b3jc7` style update) —
                 votes binaires +1/-1. Pas de border button, juste l'icône
                 en couleur (muted par défaut, accent green/red quand voté).
                 Re-cliquer même direction retract (toggle). Pas de fan-out. -->
            <span class="comment-votes" :class="{ 'comment-votes--busy': voteBusy }">
                <button
                    type="button"
                    class="comment-vote-btn comment-vote-btn--up"
                    :class="{ 'comment-vote-btn--mine': votesSummary.mine === 1 }"
                    :disabled="voteBusy"
                    :title="votesSummary.mine === 1 ? 'Retract your up-vote' : 'Up-vote this comment'"
                    @click="vote(1)"
                >
                    <i class="pi pi-thumbs-up" />
                    <span v-if="votesSummary.up > 0" class="comment-vote-count">{{ votesSummary.up }}</span>
                </button>
                <button
                    type="button"
                    class="comment-vote-btn comment-vote-btn--down"
                    :class="{ 'comment-vote-btn--mine': votesSummary.mine === -1 }"
                    :disabled="voteBusy"
                    :title="votesSummary.mine === -1 ? 'Retract your down-vote' : 'Down-vote this comment'"
                    @click="vote(-1)"
                >
                    <i class="pi pi-thumbs-down" />
                    <span v-if="votesSummary.down > 0" class="comment-vote-count">{{ votesSummary.down }}</span>
                </button>
            </span>
            <!-- #827 david `d8jxw9`+`hvdvkn` — resurface bell (Material Symbol
                 `room_service`) tout à droite après les thumbs up/down (= dernière
                 chip de la ligne d'action). Toujours visible, opacity 0.45
                 default + 1 au hover. Click reset `seen_at` sur tous les pings
                 du message → recipients re-voient au prochain wake. Le post-click
                 ✓ flash 1.5s. -->
            <span
                class="comment-resurface"
                role="button"
                tabindex="0"
                :title="resurfaceDone
                    ? `re-surfaced ${resurfaceCount} ping${resurfaceCount === 1 ? '' : 's'}`
                    : 'Re-mettre ce message en non-lu (les recipients le re-verront au prochain wake)'"
                @click="resurfaceMessage"
                @keydown.enter.prevent="resurfaceMessage"
                @keydown.space.prevent="resurfaceMessage"
            >
                <span
                    v-if="resurfaceDone"
                    class="comment-resurface-done"
                >✓</span>
                <span
                    v-else
                    class="material-symbols-outlined"
                >room_service</span>
            </span>
        </div>
    </div>
</template>

<style scoped>
/* #309: muted placeholder shown in place of a deleted comment's body. */
.comment-tombstone {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0.1rem;
    color: var(--p-text-muted-color, #888);
    font-size: 0.85rem;
}
/* #518 (david `7b3jc7`) — vote buttons inline footer. Pas de border button,
   juste l'icône. Muted neutre par défaut, accent vert (up) / rouge (down)
   quand l'utilisateur a voté. */
.comment-votes {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
}
.comment-votes--busy { opacity: 0.6; }
.comment-vote-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--p-text-muted-color);
    font-size: 0.95rem;
    cursor: pointer;
    transition: color 120ms;
}
.comment-vote-btn:hover:not(:disabled) {
    color: var(--p-text-color);
}
.comment-vote-btn--up.comment-vote-btn--mine { color: var(--p-green-500); }
.comment-vote-btn--down.comment-vote-btn--mine { color: var(--p-red-500); }
.comment-vote-btn:disabled { cursor: progress; }
.comment-vote-count {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: 0.78rem;
}
</style>

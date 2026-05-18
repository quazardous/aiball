<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Popover from "primevue/popover";
import Select from "primevue/select";
import SplitButton from "primevue/splitbutton";
import Tag from "primevue/tag";
import Textarea from "primevue/textarea";
import { useToast } from "primevue/usetoast";
import { api, INTENTS, type Message, type Intent, type Tag as TagType, type ThreadView as ThreadViewData } from "../lib/api";
import { findActiveDecision, type CommentDecision } from "../lib/decisions";
import { STATUS_SEVERITY } from "../lib/labels";
import { topDown, toggleTopDown } from "../lib/prefs";
import { RELATION_KINDS, RELATION_LABELS as TYPED_RELATION_LABELS, type RelationKind } from "../lib/relations";
import { bus, useBus } from "../lib/bus";
import { isPeek } from "../lib/peek";
import { attachPasteImage } from "../lib/pasteImage";
import MarkdownView from "./MarkdownView.vue";
import MessageComposer from "./MessageComposer.vue";
import CommentNode from "./CommentNode.vue";
import TagPicker from "./TagPicker.vue";

const props = defineProps<{ ticketId: number }>();
const emit = defineEmits<{ (e: "back"): void }>();

const data = ref<ThreadViewData | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const decideBusy = ref(false);

// #B.123 phase B.2.b: add-relation widget state. Inline panel that
// expands under the relations chips row when the user clicks "+
// relation". Target id parsed from input (accepts "42", "#B.42" or
// "B.42"); kind defaults to relates_to. Errors surface in toast.
const addRelationOpen = ref(false);
const newRelationTarget = ref("");
const newRelationKind = ref<RelationKind>("relates_to");
const addRelationBusy = ref(false);
const relationKindOptions = RELATION_KINDS.map((k) => ({
    label: TYPED_RELATION_LABELS[k],
    value: k,
}));
async function submitNewRelation() {
    if (!data.value) return;
    const raw = newRelationTarget.value.trim().replace(/^#?B?\.?/i, "");
    const target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) {
        editToast.add({
            severity: "warn",
            summary: "Invalid target ticket id",
            detail: "Type a ticket number, e.g. 42 or #B.42",
            life: 4000,
        });
        return;
    }
    addRelationBusy.value = true;
    try {
        await api.addRelation(data.value.ticket.id, target, newRelationKind.value);
        await load();
        addRelationOpen.value = false;
        newRelationTarget.value = "";
        newRelationKind.value = "relates_to";
    } catch (e) {
        editToast.add({
            severity: "error",
            summary: "Could not add relation",
            detail: (e as Error).message,
            life: 6000,
        });
    } finally {
        addRelationBusy.value = false;
    }
}

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

watch(() => props.ticketId, load);
onMounted(load);

// React to bus-driven refreshes (WS events, local actions in this or
// any sibling component). The thread reloads itself instead of being
// poked imperatively by the parent through a ref — the parent only has
// to emit on the bus and any open thread that matches reloads.
useBus("thread.refresh", ({ ticketId }) => {
    if (ticketId === props.ticketId) load();
});

// Auto-mark this ticket as read after a short dwell on the detail view
// (per #B91). Two seconds is short enough to feel natural when reading,
// long enough to avoid marking pass-through scrolling. The timer cancels
// on ticket switch (watch) and on unmount, so quick navigations don't
// flip the read state.
const AUTO_MARK_READ_MS = 2000;
let autoMarkTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAutoMarkRead() {
    if (autoMarkTimer) clearTimeout(autoMarkTimer);
    if (isPeek()) {
        // Peek mode → don't touch the endorsed agent's seen-state.
        return;
    }
    const id = props.ticketId;
    autoMarkTimer = setTimeout(() => {
        api.markTicketRead(id)
            .then(() => {
                // Read state is per-consumer, so the server doesn't
                // broadcast it on WS. Push it onto the bus so the
                // sidebar/list badges follow.
                bus.emit("read-state.changed", {
                    ticket_id: id,
                    consumer_id: localStorage.getItem("aiball.human_id") ?? "human",
                    unread: false,
                });
                bus.emit("projects.refresh");
                bus.emit("inbox.refresh");
            })
            .catch(() => {/* silent — read state is best-effort */});
        autoMarkTimer = null;
    }, AUTO_MARK_READ_MS);
}
watch(() => props.ticketId, scheduleAutoMarkRead, { immediate: true });
onBeforeUnmount(() => {
    if (autoMarkTimer) {
        clearTimeout(autoMarkTimer);
        autoMarkTimer = null;
    }
});

// Delegated to the shared severity catalog (#B.122) — the local
// switch-case duplicated STATUS_SEVERITY from `lib/labels.ts`.
function statusSeverity(s: "pending" | "approved" | "rejected") {
    return STATUS_SEVERITY[s];
}

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
function onTagsChanged(tags: TagType[]) {
    if (data.value) data.value.ticket.tags = tags;
}

// Title + body edit (per #B.94): buffered drafts, save on explicit
// "save" button or Ctrl/Cmd+Enter, cancel reverts. Drafts persist
// to sessionStorage per ticket id so a page refresh mid-edit doesn't
// lose typing — when the panel reopens, the saved draft takes
// priority over the current DB values. Cleared on save (success)
// and on cancel.
const titleDraft = ref("");
const bodyDraft = ref("");
const bodyBusy = ref(false);

function draftKey(ticketId: number): string {
    return `aiball.draft.ticket.${ticketId}`;
}

watch(
    [() => props.ticketId, editing, () => data.value?.ticket.id],
    () => {
        if (!editing.value || !data.value) return;
        const tid = data.value.ticket.id;
        const saved = sessionStorage.getItem(draftKey(tid));
        if (saved !== null) {
            try {
                const { title, body } = JSON.parse(saved) as { title?: string; body?: string };
                titleDraft.value = typeof title === "string" ? title : (data.value.ticket.title ?? "");
                bodyDraft.value = typeof body === "string" ? body : (data.value.ticket.body ?? "");
                return;
            } catch {
                // Corrupted draft — fall through to DB values.
            }
        }
        titleDraft.value = data.value.ticket.title ?? "";
        bodyDraft.value = data.value.ticket.body ?? "";
    },
);

// Mirror drafts into sessionStorage on every change while editing.
watch([titleDraft, bodyDraft], ([t, b]) => {
    if (!editing.value || !data.value) return;
    sessionStorage.setItem(
        draftKey(data.value.ticket.id),
        JSON.stringify({ title: t, body: b }),
    );
});
/**
 * Save any pending title + body changes and close the edit panel.
 * Title and body draft mutations are buffered (no auto-save on blur),
 * so a single click on "save" — or Ctrl/Cmd+Enter inside the body —
 * commits both fields in one shot. Intent and tags save live and
 * aren't part of this commit cycle.
 */
async function saveAndCloseEdit() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    const currentTitle = data.value.ticket.title ?? "";
    const currentBody = data.value.ticket.body ?? "";
    const titleChanged = titleDraft.value !== currentTitle;
    const bodyChanged = bodyDraft.value !== currentBody;
    if (!titleChanged && !bodyChanged) {
        editing.value = false;
        return;
    }
    bodyBusy.value = true;
    try {
        const patch: { title?: string; body?: string } = {};
        if (titleChanged) patch.title = titleDraft.value;
        if (bodyChanged) patch.body = bodyDraft.value;
        await api.edit(tid, patch);
        sessionStorage.removeItem(draftKey(tid));
        broadcastRefresh(tid);
        editing.value = false;
    } catch (e) {
        error.value = (e as Error).message;
        // Rollback drafts so the panel reflects what's actually in the DB.
        if (titleChanged) titleDraft.value = currentTitle;
        if (bodyChanged) bodyDraft.value = currentBody;
    } finally {
        bodyBusy.value = false;
    }
}

/**
 * Drop any unsaved title/body edits and close the panel. Intent and
 * tags changes made during the session aren't reverted — those saved
 * live the moment the user changed them. Also clears the
 * sessionStorage draft so the next open re-seeds from the DB.
 */
function cancelEdit() {
    if (data.value) {
        sessionStorage.removeItem(draftKey(data.value.ticket.id));
        titleDraft.value = data.value.ticket.title ?? "";
        bodyDraft.value = data.value.ticket.body ?? "";
    }
    editing.value = false;
}

// Paste-image on the body textarea of the edit panel (per #B.76).
// The textarea is mounted/unmounted by `v-if="editing"`, so we hook
// the listener whenever it appears and detach when it leaves.
const editBodyTextareaRef = ref<{ $el?: HTMLTextAreaElement } | null>(null);
const editToast = useToast();
let editDetachPaste: (() => void) | null = null;

watch(editBodyTextareaRef, (instance) => {
    editDetachPaste?.();
    editDetachPaste = null;
    const el = instance?.$el;
    if (!el) return;
    editDetachPaste = attachPasteImage(el, bodyDraft, {
        onError(err) {
            editToast.add({
                severity: "error",
                summary: "Image paste failed",
                detail: err.message,
                life: 5000,
            });
        },
    });
});
onBeforeUnmount(() => editDetachPaste?.());

// Comments render flat under the ticket. Nested replies are no longer
// shown as a tree — to refer back to a specific comment, the reader
// copies its #N ref and pastes it (or quotes with `> ...`) into a fresh
// top-level comment. The data layer still tolerates parent_message_id
// for backward compatibility but the UI ignores it.
const flatComments = computed<Message[]>(() => {
    if (!data.value) return [];
    const sorted = [...data.value.comments].sort((a, b) => a.id - b.id);
    return topDown.value ? sorted.reverse() : sorted;
});

// #B.130: latest summary_until wins. Scan all approved comments,
// pick the most recent one carrying `meta.summary_until`. That's the
// canonical "current state of the thread" snippet to show as a
// banner. Older summary_until values are invisible/lost (per david).
const latestSummaryUntil = computed<{ text: string; by: string | null; ts: string } | null>(() => {
    if (!data.value) return null;
    let best: { text: string; by: string | null; ts: string; id: number } | null = null;
    for (const m of data.value.comments) {
        if (m.kind !== "comment_added") continue;
        if (m.status === "rejected") continue;
        if (!m.meta) continue;
        let summaryUntil: string | undefined;
        try {
            summaryUntil = (JSON.parse(m.meta) as { summary_until?: string }).summary_until;
        } catch { continue; }
        if (!summaryUntil) continue;
        if (!best || m.id > best.id) {
            best = { text: summaryUntil, by: m.by_agent, ts: m.created_at, id: m.id };
        }
    }
    return best;
});

/**
 * Relation events (`ticket_sub_added` / `ticket_referenced`) render
 * compact — they're machine-generated notifications, not authored
 * content. Consecutive same-kind same-author events within a 60s
 * window collapse into one row: "added 8 sub-tickets: #B.66, #B.67, …"
 * (per user feedback on #B.62: "gère la factorisation en front si
 * plusieurs relation se suivent").
 */
type ThreadItem =
    | { kind: "comment"; msg: Message }
    | { kind: "relation_group"; msgs: Message[] };

function isRelationKind(k: Message["kind"]): boolean {
    return k === "ticket_sub_added" || k === "ticket_referenced";
}

const RELATION_LABELS: Record<string, { icon: string; verbOne: string; verbMany: string }> = {
    ticket_sub_added: {
        icon: "pi pi-sitemap",
        verbOne: "added sub-ticket",
        verbMany: "added sub-tickets",
    },
    ticket_referenced: {
        icon: "pi pi-link",
        verbOne: "referenced from",
        verbMany: "referenced from",
    },
};

/**
 * Compact one-word labels for the lifecycle stage badge rendered next
 * to ticket refs in relation rows and sub-ticket recap items (per
 * #B.70 follow-up). `open` is intentionally NOT in the table — it's
 * the default, no badge needed.
 */
const STAGE_LABELS: Record<string, string> = {
    rejected: "rejected",
    "closed-resolved": "closed ✓",
    closed: "closed",
    resolved: "resolved",
    snoozed: "snoozed",
    pending: "pending",
};

const threadItems = computed<ThreadItem[]>(() => {
    const items = flatComments.value;
    const out: ThreadItem[] = [];
    let i = 0;
    while (i < items.length) {
        const m = items[i];
        if (!isRelationKind(m.kind)) {
            out.push({ kind: "comment", msg: m });
            i++;
            continue;
        }
        // Collect a run of same-kind same-author events within 60s.
        const group: Message[] = [m];
        let j = i + 1;
        while (j < items.length) {
            const n = items[j];
            if (n.kind !== m.kind) break;
            if (n.by_agent !== m.by_agent) break;
            const dt = Math.abs(
                new Date(n.created_at).getTime() - new Date(m.created_at).getTime(),
            );
            if (dt > 60_000) break;
            group.push(n);
            j++;
        }
        out.push({ kind: "relation_group", msgs: group });
        i = j;
    }
    return out;
});

function shortTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

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

// Only the most recent pending entry surfaces a "pending" tag — older
// pending rows would just add noise once the moderator's attention is
// already drawn to the latest one.
const latestPendingId = computed<number | null>(() => {
    let latest: number | null = null;
    for (const c of flatComments.value) {
        if (c.status === "pending") latest = c.id;
    }
    return latest;
});

// Latest pending resolution proposal — used to surface explicit
// accept / not-resolved controls near the composer instead of inside
// the comment card itself (per #C104). Once the ticket is closed the
// proposal is moot, so we never surface a decision UI in that state.
const pendingResolution = computed<Message | null>(() => {
    if (!data.value || data.value.ticket.closed) return null;
    const pending = data.value.comments
        .filter((m) => m.kind === "ticket_resolved" && m.status === "pending")
        .sort((a, b) => b.id - a.id);
    return pending[0] ?? null;
});

// #B.129 phase 3: the active decision = the most recent comment_added
// in this thread carrying `meta.decision.status === "pending"`. Drives
// the accept/reject pair under the composer. Replaces the legacy
// pendingResolution path for new posts (the legacy lookup above stays
// only so historical `ticket_resolved` rows still get the right UI).
const activeDecision = computed<{ message: Message; decision: CommentDecision } | null>(() => {
    if (!data.value || data.value.ticket.closed) return null;
    return findActiveDecision(data.value.comments);
});

// Body of the in-thread composer, exposed here so the resolution-decision
// buttons can piggy-back on whatever the user has typed (e.g. closing the
// ticket while explaining what was done in the textarea).
const composerBody = ref("");

const resolutionBusy = ref(false);
async function postBodyAs(
    kind:
        | "comment_added"
        | "ticket_closed"
        | "ticket_resolved"
        | "ticket_blocked"
        | "ticket_reopened",
    decisionKind?: "plan" | "resolution",
) {
    if (!data.value) return;
    const t = data.value.ticket;
    const trimmed = composerBody.value.trim();
    if (!trimmed && kind === "comment_added" && !decisionKind) return; // no-op
    const byAgent = localStorage.getItem("aiball.human_id") || "human";
    // Goes through api.postMessage → req() so the bearer token + the
    // X-Aiball-Consumer header are attached. Hitting fetch() directly
    // bypassed both and returned 401 once auth became mandatory.
    await api.postMessage({
        project: t.project,
        kind,
        ticket_id: t.id,
        parent_id: t.id,
        body: trimmed || undefined,
        by_agent: byAgent,
        decision_kind: decisionKind,
    });
}
async function acceptResolution(asKind?: "plan" | "resolution") {
    const msg = pendingResolution.value;
    if (!msg || !data.value) return;
    const tid = data.value.ticket.id;
    const effectiveKind = asKind ?? "resolution";
    resolutionBusy.value = true;
    try {
        await api.approve(msg.id);
        // #B.129 follow-up: the reporter can reclassify a legacy
        // ticket_resolved row as "really a plan" — same mechanic as
        // the new decision-on-comment flow. We approve the message
        // either way; the close is suppressed when accepting as plan.
        // When reclassifying, post a marker comment so the audit
        // trail shows the reclassification.
        if (effectiveKind === "plan") {
            if (composerBody.value.trim()) {
                await postBodyAs("comment_added");
            } else {
                // Even with no body, drop a tiny audit comment so
                // future readers see the reclassification happened.
                const t = data.value.ticket;
                const byAgent = localStorage.getItem("aiball.human_id") || "human";
                await api.postMessage({
                    project: t.project,
                    kind: "comment_added",
                    ticket_id: t.id,
                    parent_id: t.id,
                    body: `(accepted as plan — ticket stays open)`,
                    by_agent: byAgent,
                });
            }
        } else {
            // The typed body (if any) rides along on the close event so the
            // reporter's "yes, this is done" gets a single decorated card
            // instead of being split between a comment and a bare close.
            await postBodyAs("ticket_closed");
        }
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}

// Menu items for the legacy pendingResolution path — same reclassify
// idea as `acceptMenu` but reached when the active "resolution" is a
// historical ticket_resolved row (not a comment+decision).
const legacyAcceptMenu = computed(() => [
    {
        label: "accept as plan (keep open)",
        icon: "pi pi-compass",
        command: () => { void acceptResolution("plan"); },
    },
]);
async function rejectResolution() {
    const msg = pendingResolution.value;
    if (!msg || !data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
        }
        await api.reject(msg.id);
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}

async function commentAndMarkResolved() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        // #B.129 phase 2: a resolution proposal is now a comment with
        // `meta.decision={kind:"resolution",status:"pending"}` rather
        // than a dedicated ticket_resolved row.
        await postBodyAs("comment_added", "resolution");
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
async function commentAndProposePlan() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        await postBodyAs("comment_added", "plan");
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
// #B.129 phase 3: accept / reject the active decision on a comment.
// For a resolution decision, accepting also closes the ticket (same
// composite action as the legacy "accept resolution and close"). For
// a plan decision, accepting just flips the meta — ticket stays open.
//
// `asKind` (#B.129 follow-up): the reporter can reclassify the
// decision at accept-time — e.g. "this was tagged as a resolution
// but it's really just a plan, accept it as a plan". When `asKind`
// is passed AND differs from the original kind, the close side-
// effect of resolution-accept is suppressed (we want plan ergonomics).
async function acceptActiveDecision(asKind?: "plan" | "resolution") {
    const active = activeDecision.value;
    if (!active || !data.value) return;
    const tid = data.value.ticket.id;
    const effectiveKind = asKind ?? active.decision.kind;
    resolutionBusy.value = true;
    try {
        // Post any typed body as a regular comment so the reporter's
        // explanation lands in the trail before the decision flip.
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
        }
        await api.decide(active.message.id, "accepted", asKind);
        if (effectiveKind === "resolution") {
            // Resolution accept = ticket closes. Mirrors the legacy
            // "accept resolution and close" composite button. When
            // the reporter reclassified to plan, the ticket stays
            // open instead.
            await postBodyAs("ticket_closed");
        }
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}

async function reclassifyActiveDecision(newKind: "plan" | "resolution") {
    const active = activeDecision.value;
    if (!active || !data.value) return;
    const tid = data.value.ticket.id;
    if (active.decision.kind === newKind) return;
    resolutionBusy.value = true;
    try {
        await api.reclassify(active.message.id, newKind);
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}

// Menu items for the reporter's accept SplitButton (#B.129 follow-up).
// Surfaces two related-but-distinct paths:
//   - "accept as <other-kind>" flips kind + status in one shot
//   - "just reclassify to <other-kind>" flips kind only, decision
//     stays pending (per david: "je dois pouvoir requalifier en
//     voici mon plan").
const acceptMenu = computed(() => {
    const active = activeDecision.value;
    if (!active) return [];
    const items: { label: string; icon: string; command: () => void }[] = [];
    if (active.decision.kind === "resolution") {
        items.push({
            label: "accept as plan (keep open)",
            icon: "pi pi-compass",
            command: () => { void acceptActiveDecision("plan"); },
        });
        items.push({
            label: "just reclassify as plan (still pending)",
            icon: "pi pi-pencil",
            command: () => { void reclassifyActiveDecision("plan"); },
        });
    } else if (active.decision.kind === "plan") {
        items.push({
            label: "accept as resolution and close",
            icon: "pi pi-check-circle",
            command: () => { void acceptActiveDecision("resolution"); },
        });
        items.push({
            label: "just reclassify as resolution (still pending)",
            icon: "pi pi-pencil",
            command: () => { void reclassifyActiveDecision("resolution"); },
        });
    }
    return items;
});
async function rejectActiveDecision() {
    const active = activeDecision.value;
    if (!active || !data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
        }
        await api.decide(active.message.id, "rejected");
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
async function commentAndClose() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        await postBodyAs("ticket_closed");
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
async function commentAndReopen() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        await postBodyAs("ticket_reopened");
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
async function commentAndUndoReject() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    resolutionBusy.value = true;
    try {
        // Re-decide the rejected ticket as approved. If a body is typed, it
        // is posted as a regular comment first so the trail of why we
        // rolled back the rejection is preserved on the thread.
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
        }
        await api.approve(tid);
        composerBody.value = "";
        broadcastRefresh(tid);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        resolutionBusy.value = false;
    }
}
const hasBody = computed(() => composerBody.value.trim().length > 0);

// #B.129 — author decision splitbutton: primary action = mark resolved
// (the most common case once work is done), dropdown reveals less-
// frequent options (propose plan, …). Keeps the visual surface tight
// — one button visible, the secondary kinds discoverable via chevron.
const decisionMenu = computed(() => [
    {
        label: hasBody.value ? "comment and propose plan" : "propose plan",
        icon: "pi pi-compass",
        command: () => { void commentAndProposePlan(); },
    },
]);

const broadcastBusy = ref(false);
// Snooze (#B.329) — popover with presets + ISO custom input.
const snoozeBusy = ref(false);
const snoozePopoverRef = ref<InstanceType<typeof Popover> | null>(null);
const snoozeCustom = ref("");

function openSnoozePopover(ev: MouseEvent) {
    snoozeCustom.value = "";
    snoozePopoverRef.value?.show(ev);
}

async function snoozeFor(ms: number) {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    snoozeBusy.value = true;
    try {
        // #B.63: if the composer has body text, post it as a comment
        // before the snooze — keeps the audit trail with the typed
        // context ("snoozing because waiting on X"). Empty composer
        // → just the snooze, same as before.
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
            composerBody.value = "";
        }
        const until = new Date(Date.now() + ms).toISOString();
        await api.postponeTicket(tid, until);
        snoozePopoverRef.value?.hide();
        bus.emit("thread.refresh", { ticketId: tid });
        bus.emit("inbox.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        snoozeBusy.value = false;
    }
}

async function snoozeCustomSubmit() {
    if (!data.value || !snoozeCustom.value) return;
    const tid = data.value.ticket.id;
    const ts = Date.parse(snoozeCustom.value);
    if (!Number.isFinite(ts) || ts <= Date.now()) {
        error.value = "Snooze date must be a valid future ISO8601 timestamp";
        return;
    }
    snoozeBusy.value = true;
    try {
        // Same as snoozeFor — embark the composer body if any.
        if (composerBody.value.trim()) {
            await postBodyAs("comment_added");
            composerBody.value = "";
        }
        await api.postponeTicket(tid, new Date(ts).toISOString());
        snoozePopoverRef.value?.hide();
        bus.emit("thread.refresh", { ticketId: tid });
        bus.emit("inbox.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        snoozeBusy.value = false;
    }
}

async function unsnooze() {
    if (!data.value) return;
    const tid = data.value.ticket.id;
    snoozeBusy.value = true;
    try {
        await api.unsnoozeTicket(tid);
        bus.emit("thread.refresh", { ticketId: tid });
        bus.emit("inbox.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        snoozeBusy.value = false;
    }
}

const isSnoozed = computed(() => {
    if (!data.value?.ticket.postponed_until) return false;
    return Date.parse(data.value.ticket.postponed_until) > Date.now();
});

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
            <Button
                v-if="data && data.ticket.status === 'approved'"
                icon="pi pi-megaphone"
                :severity="data.ticket.broadcast ? 'success' : 'secondary'"
                size="small"
                :text="!data.ticket.broadcast"
                rounded
                class="broadcast-toggle"
                :class="{ 'broadcast-toggle--off': !data.ticket.broadcast }"
                :loading="broadcastBusy"
                :title="data.ticket.broadcast
                    ? 'Broadcast ON: project followers receive pings on this thread. Click to make it internal-only.'
                    : 'Broadcast OFF (default): only project owners and explicit thread followers receive pings. Click to broadcast to all project followers.'"
                @click="toggleBroadcast"
            />
            <Button
                v-if="data && data.ticket.status !== 'rejected' && !data.ticket.closed && !isSnoozed"
                icon="pi pi-history"
                severity="info"
                size="small"
                text
                rounded
                :loading="snoozeBusy"
                title="Snooze this ticket — it disappears from the open inbox until the date you pick, then auto-reappears."
                @click="openSnoozePopover"
            />
            <Button
                v-if="data && isSnoozed"
                icon="pi pi-bell"
                severity="info"
                size="small"
                :loading="snoozeBusy"
                :title="`Snoozed until ${data.ticket.postponed_until ? new Date(data.ticket.postponed_until).toLocaleString() : ''} — click to bring back now.`"
                @click="unsnooze"
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
            <template v-if="data && data.ticket.status === 'approved' && !data.ticket.closed">
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
                        @click="rejectActiveDecision"
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
                        @click="() => acceptActiveDecision()"
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
                        @click="rejectResolution"
                    />
                    <Button
                        icon="pi pi-verified"
                        severity="success"
                        size="small"
                        text
                        rounded
                        :loading="resolutionBusy"
                        title="Accept the resolution and close. Embarks any text typed in the composer."
                        @click="() => acceptResolution()"
                    />
                </template>
                <template v-else>
                    <Button
                        v-if="!data.ticket.resolved && !data.ticket.blocked"
                        icon="pi pi-check-circle"
                        severity="success"
                        size="small"
                        text
                        rounded
                        :loading="resolutionBusy"
                        title="Mark resolved (soft proposal — reporter accepts to close). Plan-proposal is available in the composer split-button. Embarks any text typed in the composer."
                        @click="commentAndMarkResolved"
                    />
                    <Button
                        v-if="data.ticket.resolved || data.ticket.blocked"
                        icon="pi pi-undo"
                        severity="warn"
                        size="small"
                        text
                        rounded
                        :loading="resolutionBusy"
                        :title="data.ticket.blocked
                            ? 'Undo the TBD flag — bring the ticket back to plain open. Embarks any text typed in the composer.'
                            : 'Undo resolved — clear the resolution and bring the ticket back to plain open. Embarks any text typed in the composer.'"
                        @click="commentAndReopen"
                    />
                    <Button
                        icon="pi pi-lock"
                        severity="secondary"
                        size="small"
                        text
                        rounded
                        :loading="resolutionBusy"
                        title="Close the ticket (only the reporter can close). Embarks any text typed in the composer."
                        @click="commentAndClose"
                    />
                </template>
            </template>
            <Button
                v-else-if="data && data.ticket.status === 'approved' && data.ticket.closed"
                icon="pi pi-unlock"
                severity="info"
                size="small"
                text
                rounded
                :loading="resolutionBusy"
                title="Reopen this ticket. Embarks any text typed in the composer."
                @click="commentAndReopen"
            />
            <template v-else-if="data && data.ticket.status === 'pending' && data.ticket.resolved && !data.ticket.closed">
                <Button
                    icon="pi pi-undo"
                    severity="warn"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    title="Undo resolved — clear the resolution while the ticket is still in moderation. Embarks any text typed in the composer."
                    @click="commentAndReopen"
                />
                <Button
                    icon="pi pi-lock"
                    severity="secondary"
                    size="small"
                    text
                    rounded
                    :loading="resolutionBusy"
                    title="Close the ticket (only the reporter can close). Embarks any text typed in the composer."
                    @click="commentAndClose"
                />
            </template>
            <Button
                v-else-if="data && data.ticket.status === 'rejected'"
                icon="pi pi-replay"
                severity="warn"
                size="small"
                text
                rounded
                :loading="resolutionBusy"
                title="Undo reject — bring this ticket back to approved. Embarks any text typed in the composer."
                @click="commentAndUndoReject"
            />
        </div>

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
                <header class="meta">
                    <Tag
                        :value="justCopiedTicket ? `copied #B.${data.ticket.id}` : `#B.${data.ticket.id}`"
                        :severity="justCopiedTicket ? 'success' : 'secondary'"
                        class="comment-ref-tag"
                        role="button"
                        tabindex="0"
                        :title="`Click to copy this ticket's reference (#B.${data.ticket.id}) — paste it in any markdown body to link back here.`"
                        @click="copyTicketRef"
                        @keydown.enter.prevent="copyTicketRef"
                        @keydown.space.prevent="copyTicketRef"
                    />
                    <Tag :value="data.ticket.project" severity="info" />
                    <Tag
                        :value="data.ticket.status"
                        :severity="statusSeverity(data.ticket.status)"
                    />
                    <!--
                        Skip the lifecycle badge when the ticket itself is
                        rejected — the `rejected` status tag rendered just
                        above already conveys "this is over" with the right
                        severity. Stacking "rejected" + "closed" would be
                        redundant and misleading (it's not a wontfix close).
                    -->
                    <Tag
                        v-if="data.ticket.status !== 'rejected' && data.ticket.closed && data.ticket.resolved"
                        value="closed (resolved)"
                        severity="success"
                        icon="pi pi-check-circle"
                    />
                    <Tag
                        v-else-if="data.ticket.status !== 'rejected' && data.ticket.closed"
                        value="closed"
                        severity="warn"
                        icon="pi pi-lock"
                    />
                    <Tag
                        v-else-if="data.ticket.resolved"
                        value="resolved (pending close)"
                        severity="success"
                        icon="pi pi-check-circle"
                    />
                    <span v-if="data.ticket.by_agent">by {{ data.ticket.by_agent }}</span>
                    <span class="spacer" />
                    <span :title="data.ticket.created_at">
                        {{ new Date(data.ticket.created_at).toLocaleString() }}
                    </span>
                </header>
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
                <!-- #B.123 phase B.2: typed relations cartouche. Chips
                     for each active relation (kind label + linked
                     target) + add-relation widget. Per-chip change-kind
                     and × remove land in B.2.c. -->
                <div
                    v-if="(data.ticket.relations && data.ticket.relations.length > 0) || true"
                    class="thread-relations"
                >
                    <span class="thread-relations__label">
                        <i class="pi pi-share-alt" />
                        Relations
                    </span>
                    <a
                        v-for="r in data.ticket.relations ?? []"
                        :key="`${r.target_ticket_id}-${r.last_event_id}`"
                        :href="`/b/${r.target_ticket_id}`"
                        class="thread-relations__chip"
                        :data-kind="r.kind"
                        :title="`${TYPED_RELATION_LABELS[r.kind]} #B.${r.target_ticket_id} — set by ${r.by_agent ?? '?'} on ${new Date(r.last_event_at).toLocaleString()}`"
                    >
                        <span class="thread-relations__kind">{{ TYPED_RELATION_LABELS[r.kind] }}</span>
                        <span class="thread-relations__target">#B.{{ r.target_ticket_id }}</span>
                    </a>
                    <Button
                        v-if="!addRelationOpen"
                        icon="pi pi-plus"
                        label="relation"
                        size="small"
                        severity="secondary"
                        text
                        title="Link this ticket to another with a typed relation (#B.123 phase B)"
                        @click="addRelationOpen = true"
                    />
                </div>
                <div v-if="addRelationOpen" class="thread-relations-form">
                    <InputText
                        v-model="newRelationTarget"
                        placeholder="target ticket — 42 or #B.42"
                        size="small"
                        :disabled="addRelationBusy"
                        style="max-width: 14rem"
                        @keydown.enter.prevent="submitNewRelation"
                    />
                    <Select
                        v-model="newRelationKind"
                        :options="relationKindOptions"
                        option-label="label"
                        option-value="value"
                        size="small"
                        :disabled="addRelationBusy"
                        style="min-width: 10rem"
                    />
                    <Button
                        label="add"
                        icon="pi pi-check"
                        size="small"
                        :loading="addRelationBusy"
                        :disabled="!newRelationTarget.trim()"
                        @click="submitNewRelation"
                    />
                    <Button
                        label="cancel"
                        size="small"
                        severity="secondary"
                        text
                        :disabled="addRelationBusy"
                        @click="addRelationOpen = false; newRelationTarget = ''"
                    />
                </div>
                <h2 class="thread-title">{{ data.ticket.title }}</h2>
                <div
                    v-if="data.ticket.resolved && !data.ticket.closed"
                    class="thread-resolved-banner"
                    :title="data.ticket.resolved_at ?? ''"
                >
                    <i class="pi pi-check-circle" />
                    Marked resolved<span v-if="data.ticket.resolved_by"> by <strong>{{ data.ticket.resolved_by }}</strong></span>
                    — the reporter can close to confirm.
                </div>
                <div
                    v-else-if="data.ticket.resolved && data.ticket.closed"
                    class="thread-resolved-banner thread-resolved-banner--closed"
                    :title="data.ticket.resolved_at ?? ''"
                >
                    <i class="pi pi-check-circle" />
                    Resolved<span v-if="data.ticket.resolved_by"> by <strong>{{ data.ticket.resolved_by }}</strong></span>
                    and closed.
                </div>
                <div
                    v-else-if="data.ticket.closed && data.ticket.status !== 'rejected'"
                    class="thread-closed-banner"
                >
                    <i class="pi pi-lock" />
                    Closed without explicit resolution (wontfix / abandoned / duplicate).
                </div>
                <div
                    v-if="isSnoozed"
                    class="thread-snoozed-banner"
                    :title="data.ticket.postponed_until ?? ''"
                >
                    <i class="pi pi-history" />
                    Snoozed until
                    <strong>
                        {{ data.ticket.postponed_until
                            ? new Date(data.ticket.postponed_until).toLocaleString()
                            : "" }}
                    </strong>
                    — hidden from the open inbox until then.
                </div>
                <div class="thread-meta-extra">
                    <Tag
                        v-if="data.ticket.intent"
                        :value="data.ticket.intent"
                        :severity="data.ticket.intent === 'panic' ? 'danger' : 'info'"
                    />
                    <span
                        v-for="t in data.ticket.tags"
                        :key="t.id"
                        class="thread-tag"
                        :style="{ background: t.color ?? 'var(--p-surface-200)' }"
                    >{{ t.name }}</span>
                    <span class="spacer" />
                    <Button
                        v-if="!editing"
                        icon="pi pi-pencil"
                        label="edit message"
                        size="small"
                        severity="secondary"
                        text
                        @click="editing = true"
                    />
                </div>
                <div v-if="editing" class="thread-edit-panel">
                    <div class="thread-edit-row">
                        <span class="thread-edit-label">Title</span>
                        <InputText
                            v-model="titleDraft"
                            :disabled="bodyBusy"
                            size="small"
                            style="flex: 1"
                            placeholder="Ticket title"
                            @keydown.enter.prevent="saveAndCloseEdit"
                        />
                    </div>
                    <div class="thread-edit-row">
                        <span class="thread-edit-label">Body</span>
                        <Textarea
                            ref="editBodyTextareaRef"
                            v-model="bodyDraft"
                            :disabled="bodyBusy"
                            :rows="6"
                            autoResize
                            style="flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.9rem;"
                            placeholder="Ticket body (markdown supported, leave blank to clear)"
                            @keydown.ctrl.enter.prevent="saveAndCloseEdit"
                            @keydown.meta.enter.prevent="saveAndCloseEdit"
                            @keydown.escape.prevent="cancelEdit"
                        />
                    </div>
                    <div class="thread-edit-row">
                        <span class="thread-edit-label">Intent</span>
                        <Select
                            :model-value="data.ticket.intent"
                            :options="intentOptions"
                            option-label="label"
                            option-value="value"
                            size="small"
                            :disabled="intentBusy"
                            style="min-width: 9rem"
                            @update:model-value="(v: Intent | null) => changeIntent(v)"
                        />
                    </div>
                    <div class="thread-edit-row">
                        <span class="thread-edit-label">Tags</span>
                        <TagPicker
                            :message-id="data.ticket.id"
                            :tags="data.ticket.tags"
                            @changed="onTagsChanged"
                        />
                    </div>
                    <div class="thread-edit-actions">
                        <span class="thread-edit-hint">
                            Title + body are saved on <kbd>⌃Enter</kbd> or "save". Intent + tags save immediately.
                        </span>
                        <Button
                            label="cancel"
                            icon="pi pi-times"
                            size="small"
                            severity="secondary"
                            text
                            :disabled="bodyBusy"
                            @click="cancelEdit"
                        />
                        <Button
                            label="save"
                            icon="pi pi-check"
                            size="small"
                            severity="success"
                            :loading="bodyBusy"
                            @click="saveAndCloseEdit"
                        />
                    </div>
                </div>
                <MarkdownView :source="data.ticket.body" />
            </article>

            <!-- #B.130: latest summary_until = canonical "current state
                 of the thread". Shown once, between the ticket body
                 and the comments list. Older summaries are invisible
                 (per david: "c'est toujours le dernier qui a raison,
                 les autres sont invisible perdu"). -->
            <div
                v-if="latestSummaryUntil"
                class="thread-summary-banner"
                :title="`Current-state summary by ${latestSummaryUntil.by ?? 'author'} at ${new Date(latestSummaryUntil.ts).toLocaleString()}. Older summaries are superseded.`"
            >
                <i class="pi pi-bookmark thread-summary-banner__icon" />
                <span class="thread-summary-banner__label">tldr</span>
                <span class="thread-summary-banner__text">{{ latestSummaryUntil.text }}</span>
            </div>

            <div v-if="flatComments.length === 0" class="aiball-empty thread-no-comments">
                No comments yet — be the first to reply.
            </div>

            <ul v-else class="thread-comments">
                <template v-for="(item, idx) in threadItems" :key="idx">
                    <li
                        v-if="item.kind === 'comment'"
                        class="thread-comment"
                    >
                        <CommentNode
                            :msg="item.msg"
                            :show-pending-tag="item.msg.id === latestPendingId"
                        />
                    </li>
                    <li
                        v-else
                        class="thread-relation-row"
                        :data-kind="item.msgs[0].kind"
                    >
                        <i :class="RELATION_LABELS[item.msgs[0].kind].icon" />
                        <span class="thread-relation-row__verb">{{
                            item.msgs.length > 1
                                ? RELATION_LABELS[item.msgs[0].kind].verbMany
                                : RELATION_LABELS[item.msgs[0].kind].verbOne
                        }}</span>
                        <span class="thread-relation-row__refs">
                            <a
                                v-for="(m, i2) in item.msgs"
                                :key="m.id"
                                :href="`/b/${m.source_ticket_id}`"
                                class="thread-relation-row__ref"
                            >
                                #B.{{ m.source_ticket_id }}<span
                                    v-if="m.source_ticket_stage && m.source_ticket_stage !== 'open'"
                                    class="thread-relation-row__stage"
                                    :data-stage="m.source_ticket_stage"
                                >{{ STAGE_LABELS[m.source_ticket_stage] }}</span><template v-if="i2 < item.msgs.length - 1">,</template>
                            </a>
                        </span>
                        <span class="thread-relation-row__meta">by {{ item.msgs[0].by_agent ?? "?" }} · {{ shortTime(item.msgs[0].created_at) }}</span>
                    </li>
                </template>
            </ul>

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
                    <header class="meta">
                        <Tag
                            :value="justCopiedTicket ? `copied #B.${data.ticket.id}` : `#B.${data.ticket.id}`"
                            :severity="justCopiedTicket ? 'success' : 'secondary'"
                            class="comment-ref-tag"
                            role="button"
                            tabindex="0"
                            :title="`Click to copy this ticket's reference (#B.${data.ticket.id}) — paste it in any markdown body to link back here.`"
                            @click="copyTicketRef"
                            @keydown.enter.prevent="copyTicketRef"
                            @keydown.space.prevent="copyTicketRef"
                        />
                        <Tag :value="data.ticket.project" severity="info" />
                        <Tag
                            :value="data.ticket.status"
                            :severity="statusSeverity(data.ticket.status)"
                        />
                        <Tag
                            v-if="data.ticket.status !== 'rejected' && data.ticket.closed && data.ticket.resolved"
                            value="closed (resolved)"
                            severity="success"
                            icon="pi pi-check-circle"
                        />
                        <Tag
                            v-else-if="data.ticket.status !== 'rejected' && data.ticket.closed"
                            value="closed"
                            severity="warn"
                            icon="pi pi-lock"
                        />
                        <Tag
                            v-else-if="data.ticket.resolved"
                            value="resolved (pending close)"
                            severity="success"
                            icon="pi pi-check-circle"
                        />
                        <span v-if="data.ticket.by_agent">by {{ data.ticket.by_agent }}</span>
                        <span class="spacer" />
                        <span :title="data.ticket.created_at">
                            {{ new Date(data.ticket.created_at).toLocaleString() }}
                        </span>
                    </header>
                    <!-- Mirror the .thread-relations row + add widget
                         from the article so the lifted headline has the
                         same info AND the same affordances as bottom-up
                         mode (the article copy is hidden in topdown via
                         CSS, so we re-render the interactive parts here). -->
                    <div class="thread-relations">
                        <span class="thread-relations__label">
                            <i class="pi pi-share-alt" />
                            Relations
                        </span>
                        <a
                            v-for="r in data.ticket.relations ?? []"
                            :key="`hdr-${r.target_ticket_id}-${r.last_event_id}`"
                            :href="`/b/${r.target_ticket_id}`"
                            class="thread-relations__chip"
                            :data-kind="r.kind"
                            :title="`${TYPED_RELATION_LABELS[r.kind]} #B.${r.target_ticket_id}`"
                        >
                            <span class="thread-relations__kind">{{ TYPED_RELATION_LABELS[r.kind] }}</span>
                            <span class="thread-relations__target">#B.{{ r.target_ticket_id }}</span>
                        </a>
                        <Button
                            v-if="!addRelationOpen"
                            icon="pi pi-plus"
                            label="relation"
                            size="small"
                            severity="secondary"
                            text
                            title="Link this ticket to another with a typed relation"
                            @click="addRelationOpen = true"
                        />
                    </div>
                    <div v-if="addRelationOpen" class="thread-relations-form">
                        <InputText
                            v-model="newRelationTarget"
                            placeholder="target ticket — 42 or #B.42"
                            size="small"
                            :disabled="addRelationBusy"
                            style="max-width: 14rem"
                            @keydown.enter.prevent="submitNewRelation"
                        />
                        <Select
                            v-model="newRelationKind"
                            :options="relationKindOptions"
                            option-label="label"
                            option-value="value"
                            size="small"
                            :disabled="addRelationBusy"
                            style="min-width: 10rem"
                        />
                        <Button
                            label="add"
                            icon="pi pi-check"
                            size="small"
                            :loading="addRelationBusy"
                            :disabled="!newRelationTarget.trim()"
                            @click="submitNewRelation"
                        />
                        <Button
                            label="cancel"
                            size="small"
                            severity="secondary"
                            text
                            :disabled="addRelationBusy"
                            @click="addRelationOpen = false; newRelationTarget = ''"
                        />
                    </div>
                    <h2 class="thread-title">{{ data.ticket.title }}</h2>
                    <div v-if="data.ticket.intent || (data.ticket.tags && data.ticket.tags.length)" class="thread-meta-extra">
                        <Tag
                            v-if="data.ticket.intent"
                            :value="data.ticket.intent"
                            :severity="data.ticket.intent === 'panic' ? 'danger' : 'info'"
                        />
                        <span
                            v-for="t in data.ticket.tags"
                            :key="t.id"
                            class="thread-tag"
                            :style="{ background: t.color ?? 'var(--p-surface-200)' }"
                        >{{ t.name }}</span>
                    </div>
                </template>
                <template #extra-actions>
                    <template v-if="activeDecision">
                        <Button
                            icon="pi pi-times"
                            :label="`reject ${activeDecision.decision.kind}`"
                            severity="secondary"
                            size="small"
                            outlined
                            :loading="resolutionBusy"
                            :disabled="!hasBody"
                            :title="hasBody
                                ? `Reject the ${activeDecision.decision.kind} — ticket stays open. Your composer body is posted as the explanation.`
                                : `Type an explanation in the composer first — rejecting a ${activeDecision.decision.kind} needs a reason.`"
                            @click="rejectActiveDecision"
                        />
                        <SplitButton
                            :label="activeDecision.decision.kind === 'resolution' ? 'accept resolution and close' : `accept ${activeDecision.decision.kind}`"
                            icon="pi pi-verified"
                            severity="success"
                            size="small"
                            :loading="resolutionBusy"
                            :model="acceptMenu"
                            menu-button-aria-label="Accept as different decision kind"
                            @click="() => acceptActiveDecision()"
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
                            @click="rejectResolution"
                        />
                        <SplitButton
                            label="accept resolution and close"
                            icon="pi pi-verified"
                            severity="success"
                            size="small"
                            :loading="resolutionBusy"
                            :model="legacyAcceptMenu"
                            menu-button-aria-label="Accept as different decision kind"
                            @click="() => acceptResolution()"
                        />
                    </template>
                    <template v-else-if="data.ticket.status === 'rejected'">
                        <Button
                            icon="pi pi-replay"
                            :label="hasBody ? 'comment and undo reject' : 'undo reject'"
                            severity="warn"
                            size="small"
                            :loading="resolutionBusy"
                            @click="commentAndUndoReject"
                        />
                    </template>
                    <template v-else-if="data.ticket.closed">
                        <Button
                            icon="pi pi-unlock"
                            :label="hasBody ? 'comment and reopen' : 'reopen ticket'"
                            severity="info"
                            size="small"
                            :loading="resolutionBusy"
                            @click="commentAndReopen"
                        />
                    </template>
                    <template v-else-if="data.ticket.status === 'pending'">
                        <Button
                            icon="pi pi-times"
                            label="reject"
                            severity="danger"
                            size="small"
                            outlined
                            :loading="decideBusy"
                            title="Reject this pending ticket. The author is notified; comments stay readable."
                            @click="decide('reject')"
                        />
                        <Button
                            icon="pi pi-check"
                            label="approve"
                            severity="success"
                            size="small"
                            :loading="decideBusy"
                            title="Approve this pending ticket so it joins the open inbox."
                            @click="decide('approve')"
                        />
                    </template>
                    <template v-else>
                        <Button
                            v-if="!data.ticket.resolved && !data.ticket.blocked && !isSnoozed"
                            icon="pi pi-history"
                            :label="hasBody ? 'comment and snooze' : 'snooze'"
                            severity="info"
                            size="small"
                            text
                            :loading="snoozeBusy"
                            title="Set aside — type your context first if you want, then pick a duration. The ticket disappears from the open inbox until then."
                            @click="openSnoozePopover"
                        />
                        <SplitButton
                            v-if="!data.ticket.resolved && !data.ticket.blocked"
                            :label="hasBody ? 'comment and mark resolved' : 'mark resolved'"
                            icon="pi pi-check-circle"
                            severity="success"
                            size="small"
                            text
                            :loading="resolutionBusy"
                            :model="decisionMenu"
                            menu-button-aria-label="Other decision actions"
                            @click="commentAndMarkResolved"
                        />
                        <Button
                            v-if="data.ticket.resolved || data.ticket.blocked"
                            icon="pi pi-undo"
                            :label="hasBody ? 'comment and undo' : 'undo'"
                            severity="warn"
                            size="small"
                            :title="data.ticket.blocked
                                ? 'Undo the TBD flag — bring the ticket back to plain open. Embarks any text typed in the composer.'
                                : 'Undo resolved — clear the resolution and bring the ticket back to plain open. Embarks any text typed in the composer.'"
                            :loading="resolutionBusy"
                            @click="commentAndReopen"
                        />
                        <Button
                            icon="pi pi-lock"
                            :label="hasBody ? 'comment and close' : 'close ticket'"
                            severity="secondary"
                            size="small"
                            :loading="resolutionBusy"
                            @click="commentAndClose"
                        />
                    </template>
                </template>
            </MessageComposer>
        </template>
    </div>
</template>

<style>
.thread-view {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
/* #B.133 follow-up: in top-down mode, newest content is at the top
   and the original ticket body goes at the bottom (per david: "même
   le body du ticket devrait être en bas non"). Composer sits just
   under the toolbar so the user types where the next comment lands.
   Re-orders the flex children — source order stays the same. */
.thread-view--top-down .thread-toolbar { order: 0; }
.thread-view--top-down > .composer { order: 1; }
.thread-view--top-down .thread-summary-banner { order: 2; }
.thread-view--top-down .thread-no-comments,
.thread-view--top-down .thread-comments { order: 3; }
.thread-view--top-down .thread-ticket { order: 4; }
/* In top-down the ticket context (#B.NNN, status tags, title, intent,
   tag chips) lives inside the composer's #headline dropdown — see
   MessageComposer's .composer-headline. Hide the in-article copies so
   they don't surface again at the bottom with the body. The "edit
   message" button stays in-article (it edits the body it sits next to). */
.thread-view--top-down .thread-ticket > header.meta,
.thread-view--top-down .thread-ticket > .thread-title,
.thread-view--top-down .thread-ticket > .thread-relations,
.thread-view--top-down .thread-ticket > .thread-relations-form { display: none; }
.thread-view--top-down .thread-ticket > .thread-meta-extra .p-tag,
.thread-view--top-down .thread-ticket > .thread-meta-extra > .thread-tag { display: none; }
.thread-toolbar {
    display: flex;
    align-items: center;
}
/* #B.133: tighten the SplitButton chevron — PrimeVue's default
   renders the menu trigger as a separate column with the same
   padding as the main button, which doubles the visual width.
   Trim the chevron column so the dropdown reads as a small affordance
   instead of a second button. */
.thread-view .p-splitbutton .p-splitbutton-dropdown {
    padding-left: 0.4rem;
    padding-right: 0.4rem;
    min-width: 1.6rem;
}
.thread-view .p-splitbutton .p-splitbutton-dropdown .p-button-icon {
    font-size: 0.7rem;
}
.thread-ticket {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}
/* Mirror the comment card's meta line so the ticket header gets the
 * same flex behaviour (chips left, date pushed right by .spacer).
 * Without this, the unstyled `<header class="meta">` rendered as a
 * block and the date glued itself behind the author name (per #B.325). */
.thread-ticket > header.meta,
.composer-headline__body > header.meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
/* #B.123 phase B.2: typed relations cartouche. Chip palette is keyed
   off data-kind so future kinds added to RELATION_KINDS can be styled
   here without touching the JS. */
.thread-relations {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    align-items: center;
}
.thread-relations__label {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.thread-relations__chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    font-size: 0.78rem;
    text-decoration: none;
    border: 1px solid var(--p-content-border-color);
    color: var(--p-text-color);
    background: var(--p-surface-50);
}
.aiball-dark .thread-relations__chip { background: var(--p-surface-800); }
.thread-relations__chip:hover { border-color: var(--p-primary-color); }
.thread-relations__chip[data-kind="depends_on"],
.thread-relations__chip[data-kind="blocks"] {
    border-color: var(--p-yellow-500);
    background: var(--p-yellow-50);
}
.aiball-dark .thread-relations__chip[data-kind="depends_on"],
.aiball-dark .thread-relations__chip[data-kind="blocks"] {
    background: rgba(255, 196, 0, 0.12);
}
.thread-relations__chip[data-kind="duplicates"] {
    border-color: var(--p-red-500);
    background: var(--p-red-50);
}
.aiball-dark .thread-relations__chip[data-kind="duplicates"] {
    background: rgba(255, 99, 99, 0.12);
}
.thread-relations__kind {
    font-weight: 600;
    color: var(--p-text-muted-color);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
}
.thread-relations__target {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-primary-color);
}
.thread-relations-form {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    padding: 0.4rem 0.6rem;
    background: var(--p-surface-50);
    border-radius: 0.4rem;
    margin-top: 0.2rem;
}
.aiball-dark .thread-relations-form {
    background: var(--p-surface-900);
}
.snooze-popover {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    min-width: 22rem;
}
.snooze-popover__title {
    font-weight: 600;
    font-size: 0.9rem;
}
.snooze-popover__presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
}
.snooze-popover__custom {
    display: flex;
    align-items: center;
    gap: 0.4rem;
}
.snooze-popover__custom-input {
    flex: 1;
}
.thread-title {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 600;
}
/* Sub-ticket lineage indicator, shown above the title when
 * data.ticket.parent_ticket_id is set. Subtle so the title stays
 * dominant — this is structural metadata, not a banner. */
.thread-parent-ref {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    align-self: flex-start;
    padding: 0.15rem 0.5rem;
    border-left: 2px solid var(--p-indigo-300);
    background: color-mix(in srgb, var(--p-indigo-500) 10%, transparent);
    border-radius: 0 0.25rem 0.25rem 0;
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
.thread-parent-ref i {
    font-size: 0.85em;
}
.thread-parent-ref__link {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-primary-color);
    text-decoration: none;
    font-weight: 600;
}
.thread-parent-ref__link:hover {
    text-decoration: underline;
}
/* Parent-side recap of children (mirrors thread-parent-ref). Shown
 * above the title when the ticket has sub-tickets. */
.thread-sub-tickets {
    align-self: stretch;
    padding: 0.4rem 0.6rem;
    border-left: 2px solid var(--p-indigo-300);
    background: color-mix(in srgb, var(--p-indigo-500) 7%, transparent);
    border-radius: 0 0.25rem 0.25rem 0;
    font-size: 0.85rem;
}
.thread-sub-tickets__header {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-weight: 600;
    color: var(--p-text-color);
    cursor: pointer;
    user-select: none;
    list-style: none;
}
/* Hide the native disclosure triangle so our chevron is the only
 * affordance — consistent across browsers. */
.thread-sub-tickets__header::-webkit-details-marker { display: none; }
.thread-sub-tickets > .thread-sub-tickets__header {
    margin-bottom: 0;
}
.thread-sub-tickets[open] > .thread-sub-tickets__header {
    margin-bottom: 0.3rem;
}
.thread-sub-tickets__chevron {
    font-size: 0.75em;
    color: var(--p-text-muted-color);
}
.thread-sub-tickets__hint {
    font-weight: 400;
    color: var(--p-text-muted-color);
    font-size: 0.92em;
}
.thread-sub-tickets__list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
}
.thread-sub-tickets__item {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    color: var(--p-text-color);
}
.thread-sub-tickets__item--closed {
    opacity: 0.6;
}
.thread-sub-tickets__id {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-primary-color);
    text-decoration: none;
    font-weight: 600;
    flex: 0 0 auto;
}
.thread-sub-tickets__id:hover {
    text-decoration: underline;
}
.thread-sub-tickets__title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.thread-sub-tickets__tag {
    font-size: 0.72rem;
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    background: color-mix(in srgb, var(--p-surface-500) 18%, transparent);
    color: var(--p-text-color);
}
.thread-sub-tickets__tag[data-stage="pending"] {
    background: color-mix(in srgb, var(--p-yellow-500) 25%, transparent);
    color: var(--p-yellow-700);
}
.thread-sub-tickets__tag[data-stage="closed"],
.thread-sub-tickets__tag[data-stage="closed-resolved"] {
    background: color-mix(in srgb, var(--p-orange-500) 20%, transparent);
    color: var(--p-orange-700);
}
.thread-sub-tickets__tag[data-stage="resolved"] {
    background: color-mix(in srgb, var(--p-green-500) 22%, transparent);
    color: var(--p-green-700);
}
.thread-sub-tickets__tag[data-stage="snoozed"] {
    background: color-mix(in srgb, var(--p-indigo-500) 22%, transparent);
    color: var(--p-indigo-700);
}
.thread-sub-tickets__tag[data-stage="rejected"] {
    background: color-mix(in srgb, var(--p-red-500) 20%, transparent);
    color: var(--p-red-700);
}
.thread-no-comments { padding: 1rem; }
.comment-card--focused {
    box-shadow: 0 0 0 2px var(--p-primary-color);
    transition: box-shadow 0.2s;
}
.thread-meta-extra {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
    font-size: 0.85rem;
}
.thread-resolved-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--p-green-500) 15%, transparent);
    border-left: 3px solid var(--p-green-500);
    font-size: 0.88rem;
}
.thread-snoozed-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--p-blue-500) 12%, transparent);
    border-left: 3px solid var(--p-blue-500);
    font-size: 0.88rem;
}
.aiball-dark .thread-snoozed-banner {
    background: color-mix(in srgb, var(--p-blue-500) 22%, transparent);
}
.aiball-dark .thread-resolved-banner {
    background: color-mix(in srgb, var(--p-green-500) 25%, transparent);
}
.broadcast-toggle--off {
    opacity: 0.45;
    transition: opacity 0.12s ease;
}
.broadcast-toggle--off:hover {
    opacity: 1;
}
.thread-resolved-banner--closed {
    background: color-mix(in srgb, var(--p-green-500) 10%, transparent);
    border-left-color: var(--p-green-600);
    opacity: 0.92;
}
.thread-closed-banner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.7rem;
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--p-orange-500) 12%, transparent);
    border-left: 3px solid var(--p-orange-500);
    font-size: 0.88rem;
    color: var(--p-text-color);
}
.aiball-dark .thread-closed-banner {
    background: color-mix(in srgb, var(--p-orange-500) 22%, transparent);
}
.thread-tag {
    border-radius: 0.3rem;
    padding: 0.1rem 0.5rem;
    font-size: 0.75rem;
    color: black;
    font-weight: 500;
}
.thread-edit-panel {
    border: 1px dashed var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--p-surface-50);
}
.aiball-dark .thread-edit-panel { background: var(--p-surface-900); }
.thread-edit-row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
}
.thread-edit-label {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    min-width: 5rem;
    padding-top: 0.3rem;
}
.thread-edit-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.4rem;
    margin-top: 0.2rem;
    border-top: 1px dashed var(--p-content-border-color);
}
.thread-edit-hint {
    flex: 1;
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
    line-height: 1.3;
}
.thread-edit-hint kbd {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.75rem;
    padding: 0.05rem 0.3rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.2rem;
    background: var(--p-surface-100);
}
.aiball-dark .thread-edit-hint kbd {
    background: var(--p-surface-800);
}
.thread-comments {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
}
.thread-comments.nested {
    margin-left: 1.4rem;
    margin-top: 0.6rem;
    border-left: 2px solid var(--p-content-border-color);
    padding-left: 0.8rem;
}
.comment-card {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.7rem 0.9rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.comment-card .meta {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.comment-note {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
/* #B.130: thread-level banner showing the latest summary_until as
   the canonical "current state of the thread". Replaces the per-
   comment banners (older ones are invisible, latest wins). */
.thread-summary-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.55rem 0.8rem;
    border-left: 3px solid var(--p-info-color, var(--p-primary-color));
    background: color-mix(in srgb, var(--p-info-color, var(--p-primary-color)) 7%, transparent);
    border-radius: 0.3rem;
    font-style: italic;
    font-size: 0.92rem;
    color: var(--p-text-color);
}
.thread-summary-banner__icon {
    color: var(--p-info-color, var(--p-primary-color));
    margin-top: 0.18rem;
    flex-shrink: 0;
}
.thread-summary-banner__label {
    font-weight: 600;
    font-style: normal;
    text-transform: uppercase;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    color: var(--p-info-color, var(--p-primary-color));
    margin-top: 0.1rem;
    flex-shrink: 0;
}
.thread-summary-banner__text {
    flex: 1;
}
.comment-ref-tag {
    cursor: pointer;
    user-select: none;
    transition: transform 0.08s ease;
}
.comment-ref-tag:hover {
    transform: translateY(-1px);
    filter: brightness(1.1);
}
.comment-date-copy {
    cursor: pointer;
    user-select: none;
    border-radius: 0.25rem;
    padding: 0.1rem 0.35rem;
    transition: background 0.1s ease, color 0.1s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.comment-date-copy:hover {
    background: var(--p-surface-100);
    color: var(--p-primary-color);
}
.aiball-dark .comment-date-copy:hover {
    background: var(--p-surface-800);
}
.comment-date-copy-icon {
    color: var(--p-green-500);
}
.pending-marker {
    color: var(--p-orange-500);
    font-weight: 700;
    font-size: 1.1rem;
    line-height: 1;
}
.md-body .comment-ref {
    color: var(--p-text-muted-color);
    text-decoration: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
}
.md-body .comment-ref:hover {
    color: var(--p-primary-color);
    text-decoration: underline;
}
.comment-lifecycle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.25rem 0.55rem;
    border-radius: 0.3rem;
    align-self: flex-start;
}
.comment-lifecycle[data-kind="ticket_resolved"] {
    background: color-mix(in srgb, var(--p-green-500) 18%, transparent);
    color: var(--p-green-700);
}
.comment-lifecycle[data-kind="ticket_blocked"] {
    background: color-mix(in srgb, var(--p-red-500) 18%, transparent);
    color: var(--p-red-700);
}
.comment-lifecycle[data-kind="ticket_closed"] {
    background: color-mix(in srgb, var(--p-orange-500) 18%, transparent);
    color: var(--p-orange-700);
}
.comment-lifecycle[data-kind="ticket_reopened"] {
    background: color-mix(in srgb, var(--p-blue-500) 18%, transparent);
    color: var(--p-blue-700);
}
.comment-lifecycle[data-kind="ticket_sub_added"] {
    background: color-mix(in srgb, var(--p-indigo-500) 18%, transparent);
    color: var(--p-indigo-700);
}
.comment-lifecycle[data-kind="ticket_referenced"] {
    background: color-mix(in srgb, var(--p-surface-500) 18%, transparent);
    color: var(--p-text-muted-color);
}
.aiball-dark .comment-lifecycle[data-kind="ticket_resolved"] { color: var(--p-green-300); }
.aiball-dark .comment-lifecycle[data-kind="ticket_blocked"] { color: var(--p-red-300); }
.aiball-dark .comment-lifecycle[data-kind="ticket_closed"] { color: var(--p-orange-300); }
.aiball-dark .comment-lifecycle[data-kind="ticket_reopened"] { color: var(--p-blue-300); }
.aiball-dark .comment-lifecycle[data-kind="ticket_sub_added"] { color: var(--p-indigo-300); }
.comment-lifecycle__ref {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-weight: 600;
    color: inherit;
    text-decoration: none;
}
.comment-lifecycle__ref:hover {
    text-decoration: underline;
}
/*
 * Compact, single-line rendering for machine-generated relation
 * events (ticket_sub_added / ticket_referenced). They don't get the
 * full comment-card visual — they're notifications, not authored
 * content.
 */
.thread-relation-row {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.2rem 0.7rem;
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
    border-left: 2px solid transparent;
}
.thread-relation-row[data-kind="ticket_sub_added"] {
    border-left-color: var(--p-indigo-300);
}
.thread-relation-row[data-kind="ticket_referenced"] {
    border-left-color: var(--p-surface-300);
}
.thread-relation-row i {
    color: var(--p-text-muted-color);
    font-size: 0.85em;
}
.thread-relation-row__verb {
    color: var(--p-text-color);
}
.thread-relation-row__refs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
}
.thread-relation-row__ref {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-primary-color);
    text-decoration: none;
}
.thread-relation-row__ref:hover {
    text-decoration: underline;
}
.thread-relation-row__stage {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 0.7rem;
    margin-left: 0.2rem;
    padding: 0 0.3rem;
    border-radius: 0.2rem;
    background: color-mix(in srgb, var(--p-surface-500) 20%, transparent);
    color: var(--p-text-muted-color);
}
.thread-relation-row__stage[data-stage="pending"] {
    background: color-mix(in srgb, var(--p-yellow-500) 25%, transparent);
    color: var(--p-yellow-700);
}
.thread-relation-row__stage[data-stage="closed"],
.thread-relation-row__stage[data-stage="closed-resolved"] {
    background: color-mix(in srgb, var(--p-orange-500) 20%, transparent);
    color: var(--p-orange-700);
}
.thread-relation-row__stage[data-stage="resolved"] {
    background: color-mix(in srgb, var(--p-green-500) 22%, transparent);
    color: var(--p-green-700);
}
.thread-relation-row__stage[data-stage="snoozed"] {
    background: color-mix(in srgb, var(--p-indigo-500) 22%, transparent);
    color: var(--p-indigo-700);
}
.thread-relation-row__stage[data-stage="rejected"] {
    background: color-mix(in srgb, var(--p-red-500) 20%, transparent);
    color: var(--p-red-700);
}
.thread-relation-row__meta {
    margin-left: auto;
    font-size: 0.78rem;
    opacity: 0.8;
}
.comment-actions {
    display: flex;
    gap: 0.4rem;
    justify-content: flex-end;
}
.comment-edit {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
.comment-edit-actions {
    display: flex;
    gap: 0.4rem;
}
.comment-reply {
    margin-top: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
}
</style>

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
import { findActiveDecision, readDecision, type CommentDecision } from "../lib/decisions";
import { STATUS_SEVERITY } from "../lib/labels";
import { topDown, toggleTopDown } from "../lib/prefs";
import { RELATION_KINDS, RELATION_LABELS as TYPED_RELATION_LABELS, type RelationKind } from "../lib/relations";
import RelationChip from "./RelationChip.vue";
import ThreadRelations from "./ThreadRelations.vue";
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
// #B.123 phase B.2.c: change-kind / remove on each relation chip.
// Posting a NEW ticket_relation event with the same target replaces
// the kind (latest-event-wins). Removing = posting with kind=ignored
// (tombstone in the replay). Both go through the same POST endpoint
// as add, no PATCH/DELETE.
async function changeRelationKind(targetId: number, newKind: RelationKind) {
    if (!data.value) return;
    addRelationBusy.value = true;
    try {
        await api.addRelation(data.value.ticket.id, targetId, newKind);
        await load();
    } catch (e) {
        editToast.add({
            severity: "error",
            summary: "Could not change relation",
            detail: (e as Error).message,
            life: 6000,
        });
    } finally {
        addRelationBusy.value = false;
    }
}
async function removeRelation(targetId: number) {
    // Tombstone via POST kind=ignored — no confirm dialog; re-adding
    // is one click via the + relation widget, low-stakes mistake.
    return changeRelationKind(targetId, "ignored");
}

// Single shared Popover for per-chip kind/remove menu — track which
// relation it currently anchors so the menu body re-renders correctly.
// `kind` is null when the menu was triggered by a fresh ticket-ref
// promote (#B.123 phase B.5) — no existing relation yet, the picker
// creates one. Otherwise it carries the existing kind (chip edit).
const relationMenuRef = ref<InstanceType<typeof Popover> | null>(null);
const relationMenuTarget = ref<{ target_ticket_id: number; kind: RelationKind | null } | null>(null);
// #B.123 follow-up: fetched title of the referenced ticket so the
// popover header reads "→ #B.NN — <title>" instead of just the
// number. Null while loading (or unfetched). Cached in-memory across
// pop-overs in the same session.
const relationMenuTargetTitle = ref<string | null>(null);
const relationTitleCache = new Map<number, string>();
async function loadRelationTargetTitle(ticketId: number): Promise<void> {
    const cached = relationTitleCache.get(ticketId);
    if (cached !== undefined) {
        relationMenuTargetTitle.value = cached;
        return;
    }
    relationMenuTargetTitle.value = null;
    try {
        const resp = await api.getTicket(ticketId);
        const title = resp?.ticket?.title ?? "";
        relationTitleCache.set(ticketId, title);
        // Only update if the popover still targets this id (user
        // might have closed + re-opened on a different ref).
        if (relationMenuTarget.value?.target_ticket_id === ticketId) {
            relationMenuTargetTitle.value = title;
        }
    } catch {
        /* silent — popover just shows the number alone */
    }
}
function openRelationMenu(
    ev: Event,
    r: { target_ticket_id: number; kind: RelationKind },
) {
    relationMenuTarget.value = { target_ticket_id: r.target_ticket_id, kind: r.kind };
    void loadRelationTargetTitle(r.target_ticket_id);
    relationMenuRef.value?.show(ev);
}
// #B.123 phase B.5: bus listener — right-click on a `.ticket-ref` in
// a rendered body opens the same menu, pre-targeting the referenced
// ticket (current kind looked up from data.ticket.relations if any).
useBus("ticket-ref.promote", (payload) => {
    if (!data.value) return;
    // Self-references are filtered upstream in MarkdownView (it gets
    // selfTicketId as a prop and skips the @contextmenu intercept so
    // the browser's native menu can show on those links). David
    // #B.123: "on peut filtrer le popup".
    const existing = (data.value.ticket.relations ?? []).find(
        (r) => r.target_ticket_id === payload.ticket_id,
    );
    relationMenuTarget.value = {
        target_ticket_id: payload.ticket_id,
        kind: existing?.kind ?? null,
    };
    void loadRelationTargetTitle(payload.ticket_id);
    // Synthesize an event whose currentTarget IS the link. PrimeVue
    // Popover stores event.currentTarget in this.eventTarget, then
    // uses it for outside-click detection (eventTarget.contains(...)
    // — anything inside is treated as "click on the trigger" and the
    // popover stays open). With the raw @contextmenu event,
    // currentTarget = .md-body, so EVERY click in the comment body
    // kept the popover open (david #C.5aqzef: "si on clique à côté
    // ça doit disparaitre"). Synthetic event with currentTarget =
    // link element scopes the trigger to just the link → outside-
    // click anywhere else now closes properly.
    const fakeEvent = { currentTarget: payload.target, target: payload.target } as unknown as Event;
    relationMenuRef.value?.show(fakeEvent, payload.target);
});
async function pickRelationKind(newKind: RelationKind) {
    const t = relationMenuTarget.value;
    if (!t) return;
    relationMenuRef.value?.hide();
    await changeRelationKind(t.target_ticket_id, newKind);
}
async function deleteFromRelationMenu() {
    const t = relationMenuTarget.value;
    if (!t) return;
    relationMenuRef.value?.hide();
    await removeRelation(t.target_ticket_id);
}

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

// Auto-mark this ticket read after a short dwell (#B.91). Bounded
// by up_to_id (#B.191) so comments arriving after the timer fires
// keep their unseen ping — inbox row stays bold+green for new content.
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
        const snapshot = data.value;
        const lastSeenId = snapshot && snapshot.ticket?.id === id
            ? Math.max(
                snapshot.ticket.id,
                ...snapshot.comments.map((c) => c.id),
              )
            : undefined;
        api.markTicketRead(id, lastSeenId)
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

// #B.129 follow-up: decorate the comment that triggered an accept/
// reject act. Heuristic (frontend-only, no schema change): a comment
// posted by user X within 60s AFTER a decision flipped to
// accepted/rejected by X on a PRIOR comment is the "decider comment".
// Build a Map<message_id, { action, target_id, target_hashid }>.
// Limitation: 60s window can both false-positive (X commented for
// unrelated reasons right after deciding) and false-negative (X took
// >60s to type the explanation). Acceptable for v1; revisit if david
// flags noise.
interface DeciderInfo {
    action: "accepted" | "rejected";
    target_id: number;
    target_hashid: string | null;
    target_kind: string;
}
const decidersByMessage = computed<Map<number, DeciderInfo>>(() => {
    const out = new Map<number, DeciderInfo>();
    if (!data.value) return out;
    const sorted = [...data.value.comments].sort((a, b) => a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
        const target = sorted[i];
        if (target.kind !== "comment_added") continue;
        const d = readDecision(target);
        if (!d || d.status === "pending" || !d.decided_by || !d.decided_at) continue;
        const decidedAt = new Date(d.decided_at).getTime();
        // Find the next comment by d.decided_by within 60s
        for (let j = i + 1; j < sorted.length; j++) {
            const cand = sorted[j];
            if (cand.kind !== "comment_added") continue;
            if (cand.by_agent !== d.decided_by) continue;
            const dt = new Date(cand.created_at).getTime() - decidedAt;
            if (dt < -1000) continue; // candidate posted before the decide
            if (dt > 60_000) break; // too late, give up
            // Don't tag the decided comment itself (e.g. if the
            // decision sat on the same author's prior comment).
            if (cand.id === target.id) continue;
            out.set(cand.id, {
                action: d.status as "accepted" | "rejected",
                target_id: target.id,
                target_hashid: target.hashid ?? null,
                target_kind: d.kind,
            });
            break;
        }
    }
    return out;
});

// #B.130: latest summary_until wins. Scan all approved comments,
// pick the most recent one carrying `meta.summary_until`. That's the
// canonical "current state of the thread" snippet to show as a
// banner. Older summary_until values are invisible/lost (per david).
const latestSummaryUntil = computed<{ text: string; by: string | null; ts: string; id: number } | null>(() => {
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
    | { kind: "relation_group"; msgs: Message[] }
    | { kind: "summary_banner" };

function isRelationKind(k: Message["kind"]): boolean {
    return k === "ticket_sub_added" || k === "ticket_referenced" || k === "ticket_relation";
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
    // #B.137: ticket_relation events used to fall back to the default
    // comment renderer (empty body → silent blank rows). Now rendered
    // inline like sub-added/referenced. The verb is generic ("linked
    // to" / "linked from") — the actual relation kind (depends_on /
    // blocks / etc.) is read from meta.relation.kind in the template
    // via decodeRelationEvent below.
    ticket_relation: {
        icon: "pi pi-share-alt",
        verbOne: "linked to",
        verbMany: "linked to",
    },
};

// #B.137: read meta.relation.kind from a ticket_relation event and
// produce the inline verb. `ignored` is the tombstone — surface it
// as "unlinked" so the timeline reads correctly.
function decodeRelationEvent(m: Message): { verb: string; target: number | null } {
    let kind: string | undefined;
    try {
        const meta = m.meta ? JSON.parse(m.meta) as { relation?: { kind?: string } } : null;
        kind = meta?.relation?.kind;
    } catch { /* malformed meta */ }
    const target = m.source_ticket_id ?? null;
    if (kind === "ignored") return { verb: "unlinked", target };
    if (kind) return { verb: `linked as ${kind}`, target };
    return { verb: "linked", target };
}

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
    // Walk the ASC-sorted comments and insert the TLDR banner right
    // AFTER the carrier comment in source order. The optional reverse
    // for top-down at the end keeps the banner between the carrier
    // and the post-summary newer comments in both modes (david:
    // "intercalé entre le commentaire qu'il porte et les suivants non
    // encore pris en compte"). #B.130.
    if (!data.value) return [];
    const ascItems = [...data.value.comments].sort((a, b) => a.id - b.id);
    const summaryCarrierId = latestSummaryUntil.value?.id ?? null;
    const out: ThreadItem[] = [];
    let i = 0;
    while (i < ascItems.length) {
        const m = ascItems[i];
        if (!isRelationKind(m.kind)) {
            out.push({ kind: "comment", msg: m });
            if (m.id === summaryCarrierId) {
                out.push({ kind: "summary_banner" });
            }
            i++;
            continue;
        }
        // Collect a run of same-kind same-author events within 60s.
        const group: Message[] = [m];
        let j = i + 1;
        while (j < ascItems.length) {
            const n = ascItems[j];
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
        // Banner insertion also applies if the carrier was the last in
        // a relation group (edge case: rare in practice — carriers are
        // comment_added, not relations — but defensive).
        if (group.some((x) => x.id === summaryCarrierId)) {
            out.push({ kind: "summary_banner" });
        }
        i = j;
    }
    return topDown.value ? out.reverse() : out;
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
    // #B.129 follow-up: when a newer activeDecision exists on a
    // comment, the legacy ticket_resolved pending row is stale and
    // its accept controls would double-post (the legacy accept-as-
    // plan path posts a "(accepted as plan)" marker comment, while
    // the new decision-on-comment path correctly just flips meta).
    // Suppress the legacy controls in that case — the user should
    // only see one accept/reject pair under the composer.
    const pending = data.value.comments
        .filter((m) => m.kind === "ticket_resolved" && m.status === "pending")
        .sort((a, b) => b.id - a.id);
    const legacyTop = pending[0] ?? null;
    if (!legacyTop) return null;
    const newer = findActiveDecision(data.value.comments);
    if (newer && newer.message.id > legacyTop.id) return null;
    return legacyTop;
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
                // The typed body becomes a plan-accepted comment so it
                // carries the chip (per #B.129 / #C.ffvfgm david: chip
                // must surface visually on the audit comment, not just
                // in the absent meta of the legacy ticket_resolved row).
                await postBodyAs("comment_added", "plan");
            } else {
                // Empty composer → drop the canned marker AND stamp
                // its meta.decision so CommentNode renders the
                // "✓ accepted plan by david" chip. Without it the
                // marker shows as bare text, no visual feedback.
                const t = data.value.ticket;
                const byAgent = localStorage.getItem("aiball.human_id") || "human";
                const posted = await api.postMessage({
                    project: t.project,
                    kind: "comment_added",
                    ticket_id: t.id,
                    parent_id: t.id,
                    body: `(accepted as plan — ticket stays open)`,
                    by_agent: byAgent,
                    decision_kind: "plan",
                });
                // Flip it to accepted immediately so the chip reads
                // "✓ accepted plan by <byAgent>" rather than "pending".
                if (posted?.id) {
                    try {
                        await api.decide(posted.id, "accepted");
                    } catch { /* race-tolerant — chip will catch up on next refresh */ }
                }
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
// idea as the new-flow acceptMenu but reached when the active
// "resolution" is a historical ticket_resolved row (not a comment+
// decision). Arrow notation matches the new-flow labels (#B.139).
const legacyAcceptMenu = computed(() => [
    {
        label: "accept resolution → close the ticket",
        icon: "pi pi-check-circle",
        command: () => { void acceptResolution(); },
    },
    {
        label: "accept as plan → keep the ticket open",
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
        // Post the typed body EXACTLY ONCE. For resolution-accept
        // the body rides along on the ticket_closed event so the
        // explanation + close show as a single decorated card; for
        // plan-accept (no close follows), the body lands as a plain
        // comment. David #B.140: previously both branches fired,
        // duplicating the body (one comment_added + one ticket_closed
        // both carrying the same text). One source of truth per accept.
        if (composerBody.value.trim() && effectiveKind !== "resolution") {
            await postBodyAs("comment_added");
        }
        await api.decide(active.message.id, "accepted", asKind);
        if (effectiveKind === "resolution") {
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
// #B.139: SplitButton had a hidden "default" action on the main
// button + alternates in the dropdown — david found the wording
// unclear (clicking a dropdown item fires that action directly, but
// the main label stays generic so the relationship is hard to read).
// Replaced with Button + popup Menu where ALL accept variants are
// explicit menu items including the "primary" path. The trigger
// button just opens the menu; user picks the variant they want.
// SplitButton main click = the kind's "natural" accept. Dropdown
// lists ALL options including the main action again (#B.139 follow-
// up — david: "tu peux réintroduire le chevron séparé plus l'action
// principale dispo immédiatement au clic direct, tout en laissant
// l'action principale aussi dans la liste"). User has two paths
// to the default: quick click OR dropdown pick. Alternates carry
// the EFFECT in the label via the arrow → notation.
const acceptMenu = computed(() => {
    const active = activeDecision.value;
    if (!active) return [];
    const items: { label: string; icon: string; command: () => void }[] = [];
    if (active.decision.kind === "resolution") {
        items.push({
            label: "accept resolution → close the ticket",
            icon: "pi pi-check-circle",
            command: () => { void acceptActiveDecision(); },
        });
        items.push({
            label: "accept as plan → keep the ticket open",
            icon: "pi pi-compass",
            command: () => { void acceptActiveDecision("plan"); },
        });
        items.push({
            label: "reclassify as plan → still pending",
            icon: "pi pi-pencil",
            command: () => { void reclassifyActiveDecision("plan"); },
        });
    } else if (active.decision.kind === "plan") {
        items.push({
            label: "accept plan → keep the ticket open",
            icon: "pi pi-check-circle",
            command: () => { void acceptActiveDecision(); },
        });
        items.push({
            label: "accept as resolution → close the ticket",
            icon: "pi pi-verified",
            command: () => { void acceptActiveDecision("resolution"); },
        });
        items.push({
            label: "reclassify as resolution → still pending",
            icon: "pi pi-pencil",
            command: () => { void reclassifyActiveDecision("resolution"); },
        });
    }
    return items;
});
// #B.167: reject as a split button — default action rejects the
// current decision kind; menu items offer requalification (reclassify
// to the other kind, leaving status pending).
const rejectMenu = computed(() => {
    const active = activeDecision.value;
    if (!active) return [];
    const other: "plan" | "resolution" = active.decision.kind === "resolution" ? "plan" : "resolution";
    return [
        {
            label: `reject ${active.decision.kind}`,
            icon: "pi pi-times",
            command: () => { void rejectActiveDecision(); },
        },
        {
            label: `reclassify as ${other} → still pending`,
            icon: "pi pi-pencil",
            command: () => { void reclassifyActiveDecision(other); },
        },
    ];
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
                            :decider="decidersByMessage.get(item.msg.id) ?? null"
                        />
                    </li>
                    <li
                        v-else-if="item.kind === 'summary_banner' && latestSummaryUntil"
                        class="thread-summary-banner thread-summary-banner--inline"
                        :title="`Current-state summary by ${latestSummaryUntil.by ?? 'author'} at ${new Date(latestSummaryUntil.ts).toLocaleString()}. Comments below (or above in top-down) are post-summary and not yet captured.`"
                    >
                        <i class="pi pi-bookmark thread-summary-banner__icon" />
                        <span class="thread-summary-banner__label">tldr</span>
                        <span class="thread-summary-banner__text">{{ latestSummaryUntil.text }}</span>
                    </li>
                    <li
                        v-else-if="item.kind === 'relation_group'"
                        class="thread-relation-row"
                        :data-kind="item.msgs[0].kind"
                    >
                        <i :class="RELATION_LABELS[item.msgs[0].kind].icon" />
                        <template v-if="item.msgs[0].kind === 'ticket_relation'">
                            <!-- typed-relation events: per-event verb
                                 derived from meta.relation.kind. Each
                                 event in the group rendered as its own
                                 "verb #B.target" pair, comma-joined. -->
                            <span class="thread-relation-row__refs">
                                <template v-for="(m, i2) in item.msgs" :key="m.id">
                                    <span class="thread-relation-row__verb">{{ decodeRelationEvent(m).verb }}</span>
                                    <a
                                        v-if="decodeRelationEvent(m).target !== null"
                                        :href="`/b/${decodeRelationEvent(m).target}`"
                                        class="thread-relation-row__ref"
                                    >#B.{{ decodeRelationEvent(m).target }}</a>
                                    <template v-if="i2 < item.msgs.length - 1">,</template>
                                </template>
                            </span>
                        </template>
                        <template v-else>
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
                        </template>
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
                    <!-- #B.143: snooze is "mental-load relief" (david's
                         framing) — should be reachable regardless of
                         which decision/state the thread is in. Lives
                         here so every branch below inherits it. -->
                    <Button
                        v-if="!data.ticket.closed && data.ticket.status !== 'rejected' && !isSnoozed"
                        icon="pi pi-history"
                        :label="hasBody ? 'comment and snooze' : 'snooze'"
                        severity="info"
                        size="small"
                        text
                        :loading="snoozeBusy"
                        title="Set aside — type your context first if you want, then pick a duration. The ticket disappears from the open inbox until then."
                        @click="openSnoozePopover"
                    />
                    <template v-if="activeDecision">
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
                            @click="rejectActiveDecision"
                        />
                        <SplitButton
                            :label="activeDecision.decision.kind === 'resolution' ? 'accept resolution → close' : `accept ${activeDecision.decision.kind} → keep open`"
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
                            label="accept resolution → close"
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
                        <!-- snooze button now lives at the top of
                             #extra-actions (#B.143) so every state
                             inherits it; no per-branch dupe here -->
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
        <!-- #B.123 phase B.2.c: shared menu for per-chip change-kind /
             remove. Anchored on demand to whichever chip triggered it. -->
        <Popover ref="relationMenuRef">
            <div class="relation-menu" v-if="relationMenuTarget">
                <!-- #B.159: explicit close (X) so the popup can be
                     dismissed without an outside-click hunt. -->
                <button
                    type="button"
                    class="relation-menu__close"
                    title="Close"
                    @click="relationMenuRef?.hide()"
                >
                    <i class="pi pi-times" />
                </button>
                <div class="relation-menu__title">
                    <template v-if="relationMenuTarget.kind === null">
                        Promote ref to relation —
                        <strong>#B.{{ relationMenuTarget.target_ticket_id }}</strong>
                    </template>
                    <template v-else>
                        Relation to <strong>#B.{{ relationMenuTarget.target_ticket_id }}</strong>
                    </template>
                    <div v-if="relationMenuTargetTitle" class="relation-menu__target-title">
                        {{ relationMenuTargetTitle }}
                    </div>
                </div>
                <div class="relation-menu__kinds">
                    <button
                        v-for="k in RELATION_KINDS.filter(x => x !== 'ignored')"
                        :key="k"
                        type="button"
                        class="relation-menu__kind-btn"
                        :class="{ 'relation-menu__kind-btn--current': k === relationMenuTarget.kind }"
                        :disabled="addRelationBusy"
                        @click="pickRelationKind(k)"
                    >
                        {{ TYPED_RELATION_LABELS[k] }}
                    </button>
                </div>
                <button
                    v-if="relationMenuTarget.kind !== null"
                    type="button"
                    class="relation-menu__remove"
                    :disabled="addRelationBusy"
                    title="Remove this relation (posts an `ignored` tombstone — re-add anytime)"
                    @click="deleteFromRelationMenu"
                >
                    <i class="pi pi-times" /> remove
                </button>
            </div>
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


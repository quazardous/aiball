<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import { useToast } from "primevue/usetoast";
import MarkdownView from "./MarkdownView.vue";
import { api, INTENTS, type Intent } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import { attachPasteImage } from "../lib/pasteImage";
import { uploadImage } from "../lib/upload";

type Mode = "ticket" | "comment";

const props = defineProps<{
    mode: Mode;
    project: string;
    ticketId?: number;
    parentId?: number | null;
    placeholder?: string;
    submitLabel?: string;
}>();
/**
 * Emitted after a successful submit so the parent can react to "the
 * composer finished" (e.g. close a modal or navigate to the freshly-
 * created thread). Carries the new message id when known (#B.98 —
 * `ticket_created` exposes its id so NewTicketPage can open it
 * instead of dumping the user back to the inbox). Data refresh is
 * fan-out on the bus.
 */
const emit = defineEmits<{ (e: "submitted", messageId: number | null): void }>();

const title = ref("");
// `body` is a v-model so the parent can attach extra-action buttons that
// piggy-back on whatever the user has typed (e.g. "accept resolution and
// close" reuses the body as the lifecycle event's comment).
const body = defineModel<string>("body", { default: "" });
const byAgent = ref(localStorage.getItem("aiball.human_id") ?? "human");
const intent = ref<Intent>("request");
const preview = ref(false);
const sending = ref(false);
const error = ref<string | null>(null);

const intentOptions = INTENTS.map((p) => ({
    label: p,
    value: p,
}));

// #B.104 pending answers — populated when the user clicks a `- [ ]`
// in a comment body (the MarkdownView emits `composer.add-answer`).
// Each entry pairs the source message id with the question id; at
// submit time, after the reply lands, we POST to
// /api/messages/<msgId>/questions/<qid>/answer to toggle the
// checkbox in the parent body.
interface PendingAnswer {
    messageId: number;
    questionId: string;
    questionText: string;
}
const pendingAnswers = ref<PendingAnswer[]>([]);

useBus("composer.add-answer", (payload) => {
    // Only react when we're a comment composer on this thread — the
    // new-ticket composer shouldn't be hijacked. Drop dupes.
    if (props.mode !== "comment") return;
    if (props.ticketId !== undefined && payload.messageId !== props.ticketId) {
        // Comment-on-comment case: the questionId lives on a comment
        // (not the ticket root). Allow when ticketId is unset (rare)
        // or always: the messageId itself drives the API call.
    }
    const dupe = pendingAnswers.value.find(
        (p) => p.messageId === payload.messageId && p.questionId === payload.questionId,
    );
    if (dupe) return;
    pendingAnswers.value.push(payload);
    // Append a quote of the question to the body so the answer lands
    // right under the question it addresses.
    const quote = "> " + (payload.questionText || "(empty question)") + "\n\n";
    const cur = body.value;
    body.value = (cur ? cur.replace(/\s*$/, "\n\n") : "") + quote;
    // Scroll the composer into view and focus the textarea so the user
    // lands ready to type (#B.104). Without this the click felt like a
    // no-op when the composer was below the fold.
    void nextTick(() => {
        const el = bodyTextareaRef.value?.$el as HTMLTextAreaElement | undefined;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus();
        // Drop the caret at the end so the user starts typing right
        // after the freshly inserted quote.
        const end = el.value.length;
        try { el.setSelectionRange(end, end); } catch { /* ignore */ }
    });
});

const isTicket = computed(() => props.mode === "ticket");
const canSubmit = computed(() =>
    isTicket.value
        ? title.value.trim().length > 0
        : body.value.trim().length > 0,
);
const submitLabel = computed(
    () => props.submitLabel ?? (isTicket.value ? "post ticket" : "post comment"),
);
const placeholder = computed(
    () =>
        props.placeholder ??
        (isTicket.value
            ? "Ticket body (optional) — markdown supported"
            : "Write a comment — markdown supported (gfm)"),
);
const roleLabel = computed(() => (isTicket.value ? "posting as" : "replying as"));

// Per-thread / per-project draft persistence (per #B.94). The composer
// preserves what's been typed across page refreshes and thread
// navigation: a reply on `#B.42` keeps its own draft, a reply on
// `#B.43` keeps its own, and the new-ticket modal in `aiball` keeps
// its own. Cleared on successful submit.
const draftKey = computed(() => {
    if (isTicket.value) return `aiball.draft.composer.ticket.${props.project}`;
    const tid = props.ticketId ?? "untargeted";
    return `aiball.draft.composer.comment.${tid}`;
});

function loadDraft() {
    const saved = sessionStorage.getItem(draftKey.value);
    if (saved === null) {
        // No draft for this scope → start with a clean slate.
        title.value = "";
        body.value = "";
        return;
    }
    if (isTicket.value) {
        try {
            const parsed = JSON.parse(saved) as {
                title?: string;
                body?: string;
                intent?: Intent;
            };
            title.value = typeof parsed.title === "string" ? parsed.title : "";
            body.value = typeof parsed.body === "string" ? parsed.body : "";
            if (parsed.intent && (INTENTS as readonly string[]).includes(parsed.intent)) {
                intent.value = parsed.intent;
            }
        } catch {
            // Corrupted draft — start fresh.
            title.value = "";
            body.value = "";
        }
    } else {
        // Comment mode: stored as plain string (body only).
        body.value = saved;
    }
}

// Re-run on mount AND whenever the scope (project / ticketId / mode)
// changes. Vue reuses the same component instance across thread
// navigation, so a watch is the right hook for "the composer now
// belongs to a different conversation, reload its draft".
watch(
    [() => props.mode, () => props.project, () => props.ticketId],
    loadDraft,
    { immediate: true },
);

// Mirror typing into sessionStorage. Cleared (instead of stored with
// empty values) when both fields are empty so we don't leave
// zero-content keys around.
watch([title, body, intent], () => {
    const key = draftKey.value;
    if (isTicket.value) {
        const empty = !title.value && !body.value && intent.value === "request";
        if (empty) sessionStorage.removeItem(key);
        else sessionStorage.setItem(
            key,
            JSON.stringify({ title: title.value, body: body.value, intent: intent.value }),
        );
    } else {
        if (!body.value) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, body.value);
    }
});

async function submit() {
    if (!canSubmit.value) return;
    sending.value = true;
    error.value = null;
    try {
        localStorage.setItem("aiball.human_id", byAgent.value);
        // Goes through api.postMessage → req() so the bearer token +
        // X-Aiball-Consumer header are attached. fetch() directly
        // skipped both and produced 401s once auth became mandatory.
        let createdId: number | null = null;
        if (isTicket.value) {
            const r = await api.postMessage({
                project: props.project,
                kind: "ticket_created",
                title: title.value.trim(),
                body: body.value,
                intent: intent.value,
                by_agent: byAgent.value || "human",
            });
            createdId = typeof r?.id === "number" ? r.id : null;
        } else {
            // Capture the comment's id too — needed by #B.104 to fill
            // the `answered_in` audit field on the parent's meta.
            const r = await api.postMessage({
                project: props.project,
                kind: "comment_added",
                ticket_id: props.ticketId,
                parent_id: props.parentId ?? props.ticketId,
                body: body.value,
                by_agent: byAgent.value || "human",
            });
            createdId = typeof r?.id === "number" ? r.id : null;
        }
        // #B.104: after the reply lands, mark every question that was
        // queued via the click-to-quote flow as answered. Done after
        // the post so the answer message id is known (used in the
        // audit `answered_in` field). Each call is independent —
        // a failure on one doesn't block the others, and the body
        // toggle on the parent is server-side idempotent.
        if (
            createdId !== null &&
            pendingAnswers.value.length > 0 &&
            !isTicket.value
        ) {
            const answeredBy = byAgent.value || "human";
            for (const pa of pendingAnswers.value) {
                try {
                    await api.markQuestionAnswered(pa.messageId, pa.questionId, {
                        answered_by: answeredBy,
                        answered_in: createdId,
                    });
                } catch (e) {
                    // Surface a discreet toast but don't fail the
                    // whole submit — the comment is already posted.
                    console.warn(
                        `[composer] failed to mark question ${pa.questionId} answered:`,
                        e,
                    );
                }
            }
        }
        // Successful post → drop the persisted draft, reset local state.
        sessionStorage.removeItem(draftKey.value);
        title.value = "";
        body.value = "";
        preview.value = false;
        pendingAnswers.value = [];
        // Refresh fan-out: WS will fire for everyone, but emitting
        // locally now makes the sender's UI feel instant.
        if (props.ticketId !== undefined) {
            bus.emit("thread.refresh", { ticketId: props.ticketId });
        }
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
        emit("submitted", createdId);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        sending.value = false;
    }
}

// Paste-image (per #B.76). Wire a handler on the body textarea so a
// Ctrl/Cmd+V of an image uploads it and inserts a markdown ![pasted](…)
// snippet at the caret. Errors surface as a toast — typical cases are
// "unsupported type" or "exceeds limit".
const bodyTextareaRef = ref<{ $el?: HTMLTextAreaElement } | null>(null);
const toast = useToast();
let detachPaste: (() => void) | null = null;

onMounted(() => {
    const el = bodyTextareaRef.value?.$el;
    if (!el) return;
    detachPaste = attachPasteImage(el, body, {
        onError(err) {
            toast.add({
                severity: "error",
                summary: "Image paste failed",
                detail: err.message,
                life: 5000,
            });
        },
    });
    // Load the @-mention catalog once (per #B.71). Cheap; the daemon
    // builds it from SELECT DISTINCT across subs/tickets/messages.
    api.mentionSuggestions()
        .then((r) => { mentionCatalog.value = r; })
        .catch(() => { /* offline OK — autocomplete just stays inert */ });
});
onBeforeUnmount(() => {
    detachPaste?.();
});

// =====================================================================
//  @-mention autocomplete (#B.71)
// =====================================================================
//
// Inline popover anchored below the textarea. Triggered by typing `@`
// (or scrolling the caret back to an existing @-token). Suggestions:
// projects first (folder icon), agents second (user icon). Selection
// replaces the partial `@xxx` with the full `@name `.

interface MentionSuggestion {
    kind: "project" | "agent";
    value: string;
}

const mentionCatalog = ref<{ projects: string[]; agents: string[] } | null>(null);
const mentionQuery = ref<string | null>(null);  // null = popover closed
const mentionTokenStart = ref(0);                // body index where the `@` sits
const mentionSelectedIdx = ref(0);

const mentionSuggestions = computed<MentionSuggestion[]>(() => {
    if (mentionQuery.value === null || !mentionCatalog.value) return [];
    const q = mentionQuery.value.toLowerCase();
    const matchProj = mentionCatalog.value.projects.filter((p) => p.toLowerCase().includes(q));
    const matchAgent = mentionCatalog.value.agents.filter((a) => a.toLowerCase().includes(q));
    return [
        ...matchProj.map((v): MentionSuggestion => ({ kind: "project", value: v })),
        ...matchAgent.map((v): MentionSuggestion => ({ kind: "agent", value: v })),
    ].slice(0, 8);
});

function detectMentionAtCaret() {
    const el = bodyTextareaRef.value?.$el;
    if (!el) {
        mentionQuery.value = null;
        return;
    }
    const caret = el.selectionStart ?? 0;
    const before = body.value.slice(0, caret);
    // Most recent `@` preceded by start-of-line or non-word non-@ char,
    // followed by 0..N word/dash/underscore chars, ending at caret.
    const m = before.match(/(?:^|[^\w@])@([a-zA-Z0-9_-]*)$/);
    if (!m) {
        mentionQuery.value = null;
        return;
    }
    mentionQuery.value = m[1];
    mentionTokenStart.value = caret - m[1].length - 1; // position of `@`
    mentionSelectedIdx.value = 0;
}

function onComposerInput() {
    // setTimeout(0) rather than rAF because rAF is throttled when the
    // browser tab is in background (the autocomplete still needs to
    // respond to typing even if the tab isn't focused).
    setTimeout(detectMentionAtCaret, 0);
}

// Belt + braces: also re-evaluate when body changes via paste, drafts,
// programmatic edits, etc. The @input handler above covers the typical
// typing path; this watch handles everything else.
watch(body, () => {
    setTimeout(detectMentionAtCaret, 0);
});

function onComposerKeydown(ev: KeyboardEvent) {
    if (mentionQuery.value === null || mentionSuggestions.value.length === 0) {
        // Re-evaluate after arrow/backspace movements that change the caret.
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(ev.key)) {
            // setTimeout(0) rather than rAF because rAF is throttled when the
    // browser tab is in background (the autocomplete still needs to
    // respond to typing even if the tab isn't focused).
    setTimeout(detectMentionAtCaret, 0);
        }
        return;
    }
    if (ev.key === "ArrowDown") {
        ev.preventDefault();
        mentionSelectedIdx.value =
            (mentionSelectedIdx.value + 1) % mentionSuggestions.value.length;
        return;
    }
    if (ev.key === "ArrowUp") {
        ev.preventDefault();
        mentionSelectedIdx.value =
            (mentionSelectedIdx.value - 1 + mentionSuggestions.value.length) %
            mentionSuggestions.value.length;
        return;
    }
    if (ev.key === "Enter" || ev.key === "Tab") {
        ev.preventDefault();
        selectMention(mentionSuggestions.value[mentionSelectedIdx.value]);
        return;
    }
    if (ev.key === "Escape") {
        ev.preventDefault();
        mentionQuery.value = null;
        return;
    }
}

function selectMention(s: MentionSuggestion) {
    const el = bodyTextareaRef.value?.$el;
    if (!el || mentionQuery.value === null) return;
    const start = mentionTokenStart.value;
    const end = start + 1 + mentionQuery.value.length;
    body.value = `${body.value.slice(0, start)}@${s.value} ${body.value.slice(end)}`;
    mentionQuery.value = null;
    setTimeout(() => {
        const pos = start + s.value.length + 2; // @ + name + space
        el.focus();
        el.setSelectionRange(pos, pos);
    }, 0);
}

// Attach button (per #B.76 follow-up). Same upload path as paste, but
// surfaces an explicit file picker so the user doesn't have to put the
// image in the clipboard first.
const attachInputRef = ref<HTMLInputElement | null>(null);
const attaching = ref(false);

function openAttachPicker() {
    attachInputRef.value?.click();
}

async function onAttachPicked(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    // Always reset so re-picking the same file fires the change event.
    input.value = "";
    if (!file) return;
    attaching.value = true;
    try {
        const { url } = await uploadImage(file);
        // Append at the end of the current body with a newline. The
        // attach button isn't position-aware (no textarea caret in
        // scope), and "append at the end" matches what GitHub does.
        const snippet = `![${file.name}](${url})`;
        body.value = body.value
            ? `${body.value.replace(/\s+$/, "")}\n\n${snippet}\n`
            : `${snippet}\n`;
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Image upload failed",
            detail: (e as Error).message,
            life: 5000,
        });
    } finally {
        attaching.value = false;
    }
}
</script>

<template>
    <div class="composer">
        <!-- #B.133: optional headline slot, rendered as a collapsible
             dropdown at the top of the composer's frame. ThreadView
             feeds the ticket header (#B.NNN tag, project, status, by,
             title, intent, tags) so in top-down mode the context lives
             "inside the reply container" instead of floating above it
             (david: "ça devrait être dans le cadre de la réponse en
             dropdown"). Hidden when the slot is empty. -->
        <details v-if="$slots.headline" class="composer-headline">
            <summary class="composer-headline__summary">
                <i class="pi pi-chevron-right composer-headline__chevron" />
                <slot name="headline-summary">context</slot>
            </summary>
            <div class="composer-headline__body">
                <slot name="headline" />
            </div>
        </details>
        <div class="composer-meta">
            <span class="field-label" style="margin: 0">{{ roleLabel }}</span>
            <InputText
                v-model="byAgent"
                size="small"
                style="max-width: 12rem"
                :disabled="sending"
            />
            <span class="spacer" />
            <ToggleButton
                v-model="preview"
                on-label="edit"
                off-label="preview"
                on-icon="pi pi-pencil"
                off-icon="pi pi-eye"
                size="small"
            />
        </div>
        <div v-if="isTicket && !preview" class="composer-title-row">
            <InputText
                v-model="title"
                placeholder="Ticket title"
                class="composer-title"
                :disabled="sending"
                @keydown.ctrl.enter.prevent="submit"
                @keydown.meta.enter.prevent="submit"
            />
            <Select
                v-model="intent"
                :options="intentOptions"
                option-label="label"
                option-value="value"
                size="small"
                :disabled="sending"
                style="min-width: 9rem"
            />
        </div>
        <div v-if="!preview" class="composer-textarea-wrap">
            <Textarea
                ref="bodyTextareaRef"
                v-model="body"
                :rows="isTicket ? 6 : 8"
                class="w-full composer-textarea"
                :placeholder="placeholder"
                :disabled="sending"
                autoResize
                @input="onComposerInput"
                @keydown="onComposerKeydown"
                @keydown.ctrl.enter.prevent="submit"
                @keydown.meta.enter.prevent="submit"
                @blur="mentionQuery = null"
            />
            <ul
                v-if="mentionQuery !== null && mentionSuggestions.length > 0"
                class="mention-popover"
                role="listbox"
            >
                <li
                    v-for="(s, i) in mentionSuggestions"
                    :key="`${s.kind}-${s.value}`"
                    class="mention-popover__item"
                    :class="{ 'mention-popover__item--selected': i === mentionSelectedIdx }"
                    role="option"
                    :aria-selected="i === mentionSelectedIdx"
                    @mousedown.prevent="selectMention(s)"
                >
                    <i :class="s.kind === 'project' ? 'pi pi-folder' : 'pi pi-user'" />
                    <span class="mention-popover__name">@{{ s.value }}</span>
                    <span class="mention-popover__kind">{{ s.kind }}</span>
                </li>
            </ul>
        </div>
        <div v-else class="composer-preview">
            <h3 v-if="isTicket && title" style="margin: 0 0 0.4rem">{{ title }}</h3>
            <MarkdownView :source="body" />
            <div v-if="!body.trim() && !title.trim()" class="aiball-empty" style="padding: 1rem">
                Nothing to preview.
            </div>
        </div>
        <div class="composer-hint">
            markdown:
            <strong>**bold**</strong>, <em>*italic*</em>, <code>`code`</code>,
            lists, links, fenced ```code blocks```
        </div>
        <div class="composer-actions">
            <Button
                icon="pi pi-paperclip"
                size="small"
                severity="secondary"
                text
                rounded
                :loading="attaching"
                :disabled="sending || attaching"
                title="Attach an image — same as Ctrl/Cmd+V on the textarea"
                @click="openAttachPicker"
            />
            <input
                ref="attachInputRef"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                style="display: none"
                @change="onAttachPicked"
            />
            <span class="spacer" />
            <slot name="extra-actions" :body="body" :sending="sending" />
            <Button
                :label="submitLabel"
                icon="pi pi-send"
                size="small"
                :loading="sending"
                :disabled="!canSubmit"
                @click="submit"
            />
        </div>
        <div v-if="error" style="color: var(--p-red-500); font-size: 0.85rem">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style>
.composer {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--p-content-background);
}
/* #B.133: collapsible ticket-context header rendered at the top of the
   composer frame in top-down mode. <details> is native and accessible;
   we just style the disclosure triangle (suppressed) and use our own
   chevron that rotates on open. */
.composer-headline {
    margin: -0.4rem -0.4rem 0;
    padding: 0.3rem 0.45rem;
    border-bottom: 1px dashed var(--p-content-border-color);
}
.composer-headline summary {
    list-style: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    user-select: none;
}
.composer-headline summary::-webkit-details-marker { display: none; }
.composer-headline__chevron {
    transition: transform 0.15s;
    font-size: 0.75rem;
}
.composer-headline[open] .composer-headline__chevron {
    transform: rotate(90deg);
}
.composer-headline__body {
    margin-top: 0.5rem;
    padding-top: 0.3rem;
}
.composer-textarea-wrap {
    position: relative;
}
/* @-mention autocomplete popover (#B.71). Anchored to the composer
 * textarea wrap; appears just below the textarea. Keyboard nav fires
 * from the textarea itself (we don't move focus). */
.mention-popover {
    /* Sit ABOVE the textarea (bottom anchor) so it doesn't cover the
     * markdown hint or the action buttons just below the composer. */
    position: absolute;
    z-index: 20;
    bottom: 100%;
    left: 0;
    margin: 0 0 0.25rem;
    padding: 0.2rem;
    list-style: none;
    min-width: 14rem;
    max-width: 22rem;
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
}
.mention-popover__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-radius: 0.3rem;
    font-size: 0.9rem;
    cursor: pointer;
}
.mention-popover__item:hover,
.mention-popover__item--selected {
    background: color-mix(in srgb, var(--p-primary-color) 14%, transparent);
}
.mention-popover__item i {
    font-size: 0.85em;
    color: var(--p-text-muted-color);
    width: 1rem;
    text-align: center;
}
.mention-popover__name {
    flex: 1;
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-text-color);
}
.mention-popover__kind {
    font-size: 0.75rem;
    color: var(--p-text-muted-color);
}
.composer-meta {
    display: flex;
    gap: 0.6rem;
    align-items: center;
}
.composer-title-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}
.composer-title {
    flex: 1;
    font-weight: 600;
}
.composer-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
}
.composer-hint {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
    line-height: 1.3;
}
.composer-preview {
    border: 1px dashed var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.8rem;
    min-height: 5rem;
}
.composer-textarea-wrap {
    width: 100%;
}
.composer-textarea {
    width: 100%;
    min-height: 10rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem;
    resize: vertical;
}
.spacer { flex: 1; }
</style>

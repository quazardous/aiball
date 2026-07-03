<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import { useToast } from "primevue/usetoast";
import MarkdownView from "./MarkdownView.vue";
import TagPicker from "./TagPicker.vue";
import { api, INTENTS, PRIORITIES, type Intent, type Priority } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import { useComposerDraft } from "../lib/composer-draft";
import { useMentionAutocomplete } from "../lib/mention-autocomplete";
import { attachPasteImage } from "../lib/pasteImage";
import { SCOPES, scopeIcon, scopeTitle } from "../lib/scope";
import { uploadFile, renderUploadSnippet, UPLOAD_ACCEPT } from "../lib/upload";

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
// #B.245 fgum2c: dropdown with per-option pictograms (internal /
// default / broadcast). Includes the icon class so the Select's
// option/value templates can render the same glyph used everywhere
// else (lists, cards).
const scopeOptions = SCOPES.map((s) => ({
    label: s,
    value: s,
    icon: scopeIcon(s),
    title: scopeTitle(s),
}));
const intent = ref<Intent>("request");
// #B.222: urgency hint orthogonal to intent. Default "normal" = invisible
// when unchanged, so 90% of ticket-creates don't pay any visual weight.
const priority = ref<Priority>("normal");
// Scope persistence (#B.245 / #253) + per-thread draft persistence
// (#B.94) live in lib/composer-draft.ts — the composable owns the
// `scope` ref, its localStorage memory, and the sessionStorage draft
// watches (WHY comments moved alongside). `draftKey` stays in scope
// here so submit() can drop the draft after a successful post.
const { scope, draftKey } = useComposerDraft({
    mode: toRef(() => props.mode),
    project: toRef(() => props.project),
    ticketId: toRef(() => props.ticketId),
    title,
    body,
    intent,
    priority,
});
// #292: tags chosen for a NEW ticket (deferred — applied after create).
const ticketTagIds = ref<number[]>([]);
// #514 (david `nd967z`) : assignee picker at create. Empty = no assign
// (ticket starts unassigned, prior behaviour). Otherwise, after the POST
// /messages, we chain a POST /tickets/<id>/assign to avoid duplicating
// the logic on the backend. Tickets only (not comments — assignee is
// ticket-level). The consumer catalog is loaded at mount (reuses the
// path `mentionCatalog` already takes).
//
// #740 david `a9rucr`: exposed as a v-model so the parent (ThreadView)
// can read it from its own `decide("approve" | "reject")` flow — the
// approve button lives outside the composer and previously ignored
// whatever the human had picked in this dropdown.
const assignee = defineModel<string>("assignee", { default: "" });
const consumerCatalog = ref<string[]>([]);
const preview = ref(false);
const sending = ref(false);
const error = ref<string | null>(null);

const intentOptions = INTENTS.map((p) => ({
    label: p,
    value: p,
}));

const priorityOptions = PRIORITIES.map((p) => ({
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
async function submit() {
    if (!canSubmit.value) return;
    sending.value = true;
    error.value = null;
    try {
        // Identity flows from localStorage (set by Setup/Login) →
        // X-Aiball-Consumer header on every api request. The composer
        // no longer edits it (#B.245 retired the "replying as"
        // InputText); we still echo it as `by_agent` on the payload so
        // the validator sees the same value the API helper would have
        // resolved.
        const author = localStorage.getItem("aiball.human_id") ?? "human";
        let createdId: number | null = null;
        if (isTicket.value) {
            const r = await api.postMessage({
                project: props.project,
                kind: "ticket_created",
                title: title.value.trim(),
                body: body.value,
                intent: intent.value,
                // Omit priority when it equals the default so the payload
                // stays clean for the typical case.
                ...(priority.value !== "normal" ? { priority: priority.value } : {}),
                by_agent: author,
                // #B.245 tristate. Forward only when non-default so the
                // payload stays clean for the typical case.
                ...(scope.value !== "default" ? { scope: scope.value } : {}),
            });
            createdId = typeof r?.id === "number" ? r.id : null;
            // #514 (nd967z) : push assign in a 2e step une fois le ticket
            // créé. Best-effort comme les tags : si l'assign rate, le ticket
            // est déjà posted, on warne et continue (le user peut retry
            // depuis le Manage panel).
            if (createdId !== null && assignee.value.trim()) {
                try {
                    await api.assignTicket(createdId, assignee.value.trim());
                } catch (e) {
                    console.warn("[composer] failed to assign new ticket:", e);
                }
            }
            // #292: apply the tags chosen in the composer to the freshly
            // created ticket (deferred — it had no id until now). Best-effort:
            // the ticket is already posted, so a tag failure only warns.
            if (createdId !== null && ticketTagIds.value.length > 0) {
                try {
                    await api.setMessageTags(createdId, ticketTagIds.value, author);
                } catch (e) {
                    console.warn("[composer] failed to apply tags to new ticket:", e);
                }
            }
        } else {
            // Capture the comment's id too — needed by #B.104 to fill
            // the `answered_in` audit field on the parent's meta.
            const r = await api.postMessage({
                project: props.project,
                kind: "comment_added",
                ticket_id: props.ticketId,
                parent_id: props.parentId ?? props.ticketId,
                body: body.value,
                by_agent: author,
                // #B.245 tristate. Forward only when non-default.
                ...(scope.value !== "default" ? { scope: scope.value } : {}),
            });
            createdId = typeof r?.id === "number" ? r.id : null;
            // #553 david : assignee picker dispo en comment mode aussi.
            // Quand l'utilisateur change l'assignee dans le composer d'update,
            // on push l'assign au ticket parent best-effort après le post.
            // Empty string = no change (l'utilisateur n'a pas touché le widget).
            if (props.ticketId && assignee.value.trim()) {
                try {
                    await api.assignTicket(props.ticketId, assignee.value.trim());
                } catch (e) {
                    console.warn("[composer] failed to assign ticket on reply:", e);
                }
            }
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
            const answeredBy = author;
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
        ticketTagIds.value = [];
        preview.value = false;
        pendingAnswers.value = [];
        // #606 david : quand l'utilisateur poste lui-même un commentaire
        // sur un thread, il l'a, par définition, lu — mark-read jusqu'à
        // ce nouvel id IMMÉDIATEMENT, sans attendre le dwell autoMarkRead.
        // Sinon l'inbox row du ticket reste unread (le up_to_id du dwell
        // précédent ne couvre que les comments ANTÉRIEURS au reply).
        if (!isTicket.value && props.ticketId !== undefined && createdId !== null) {
            try {
                await api.markTicketRead(props.ticketId, createdId);
                bus.emit("read-state.changed", {
                    ticket_id: props.ticketId,
                    consumer_id: author,
                    unread: false,
                });
            } catch (e) {
                console.warn("[composer] failed to mark-read after own reply:", e);
            }
        }
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
    // #514 + #553 — assignee picker (tickets + comments) : on charge le
    // catalog des consumers une fois au mount. Ignoré si offline.
    api.listConsumers()
        .then((r) => { consumerCatalog.value = r.map((c) => c.consumer_id); })
        .catch(() => { /* assignee picker just stays empty */ });
});
onBeforeUnmount(() => {
    detachPaste?.();
});

// @-mention autocomplete (#B.71 / #515) — the machinery (catalog fetch,
// caret detection, keyboard nav, selection splice) lives in
// lib/mention-autocomplete.ts. The popover template + its CSS stay in
// this component.
const {
    mentionQuery,
    mentionSelectedIdx,
    mentionFilter,
    mentionSuggestions,
    setMentionFilter,
    onComposerInput,
    onComposerKeydown,
    selectMention,
} = useMentionAutocomplete(bodyTextareaRef, body);

// Attach button (per #B.76 follow-up, #694 widened to text/code/binary).
// Picker accepts the same allow-list the server enforces ; the rendered
// markdown snippet adapts to the type (inline image / link / 📎 binary).
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
        const { url, content_type } = await uploadFile(file);
        // Append at the end of the current body with a newline. The
        // attach button isn't position-aware (no textarea caret in
        // scope), and "append at the end" matches what GitHub does.
        const snippet = renderUploadSnippet(file.name, url, content_type);
        body.value = body.value
            ? `${body.value.replace(/\s+$/, "")}\n\n${snippet}\n`
            : `${snippet}\n`;
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Upload failed",
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
        <!-- #B.133: optional headline slot at the top of the composer
             frame. In top-down mode ThreadView feeds the full ticket
             header here (meta tags, title, intent, tags, typed
             relations) so the user has the same info as the non-topdown
             view, just embedded in the composer card. David: "il faut
             garder les memes info même présentation que le non top
             down" + "pas besoin du chevron". Always visible, no
             disclosure widget. -->
        <div v-if="$slots.headline" class="composer-headline">
            <slot name="headline" />
        </div>
        <div class="composer-meta">
            <!-- #553 david : scope picker affiché UNIQUEMENT à la création de
                 ticket (ticket mode). En comment/update mode, le scope
                 disparaît du composer (ira dans ManagePanel quand le PATCH
                 endpoint sera prêt — Phase 2). Replies se font donc avec le
                 scope ticket-level inherited (default → fan-out normal). -->
            <Select
                v-if="isTicket"
                v-model="scope"
                :options="scopeOptions"
                option-label="label"
                option-value="value"
                size="small"
                :disabled="sending"
                aria-label="Event scope"
                class="composer-scope"
                title="Scope (#B.245) — composer remembers your last choice per ticket."
            >
                <template #value="slotProps">
                    <span class="composer-scope-option">
                        <i
                            v-if="slotProps.value && scopeIcon(slotProps.value)"
                            :class="['pi', scopeIcon(slotProps.value)]"
                        />
                        <span>{{ slotProps.value ?? "default" }}</span>
                    </span>
                </template>
                <template #option="slotProps">
                    <span
                        class="composer-scope-option"
                        :title="slotProps.option.title"
                    >
                        <i
                            v-if="slotProps.option.icon"
                            :class="['pi', slotProps.option.icon]"
                            style="width: 1rem; text-align: center"
                        />
                        <i
                            v-else
                            style="width: 1rem; display: inline-block"
                        />
                        <span>{{ slotProps.option.label }}</span>
                    </span>
                </template>
            </Select>
            <!-- #514 + #553 — assignee picker disponible dans TICKET mode
                 (création) ET COMMENT mode (update/reply). En reply, change
                 l'assignee du ticket parent au moment du submit. Icone-only,
                 compact. -->
            <Select
                v-if="isTicket || props.mode === 'comment'"
                v-model="assignee"
                :options="consumerCatalog"
                size="small"
                show-clear
                filter
                :disabled="sending"
                aria-label="Assignee"
                class="composer-assignee"
                title="Assignee — the consumer responsible for this ticket. Empty = unassigned."
            >
                <template #value="slotProps">
                    <span class="composer-scope-option">
                        <i class="pi pi-user" />
                        <span v-if="slotProps.value">{{ slotProps.value }}</span>
                    </span>
                </template>
                <template #option="slotProps">
                    <span class="composer-scope-option">
                        <i class="pi pi-user" style="width: 1rem; text-align: center" />
                        <span>{{ slotProps.option }}</span>
                    </span>
                </template>
            </Select>
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
            <Select
                v-model="priority"
                :options="priorityOptions"
                option-label="label"
                option-value="value"
                size="small"
                :disabled="sending"
                style="min-width: 9rem"
                title="Priority (#B.222) — urgent / high / normal / low"
            />
        </div>
        <!-- #292: pick tags at creation time (deferred TagPicker — applied
             once the ticket has an id, on submit). Ticket mode only. -->
        <div v-if="isTicket && !preview" class="composer-tags-row">
            <span class="composer-tags-label">tags</span>
            <TagPicker v-model:selectedIds="ticketTagIds" />
        </div>
        <!-- #514 (david `4dfqj4`) : assignee picker déplacé dans le
             composer-meta à côté du scope (icone bonhomme uniquement,
             pas de label). Cf. plus haut. La row dédiée a été retirée. -->
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
            <div
                v-if="mentionQuery !== null"
                class="mention-popover"
                role="listbox"
            >
                <!-- #515 — chips filtre par catégorie. Default "all" (les
                     2 mélangés). Mousedown.prevent pour ne pas blur le
                     textarea (qui fermerait le popover). -->
                <div class="mention-popover__filters" role="tablist">
                    <button
                        type="button"
                        class="mention-popover__filter-chip"
                        :class="{ 'mention-popover__filter-chip--active': mentionFilter === 'all' }"
                        role="tab"
                        :aria-selected="mentionFilter === 'all'"
                        @mousedown.prevent="setMentionFilter('all')"
                    >
                        <i class="pi pi-list" /> all
                    </button>
                    <button
                        type="button"
                        class="mention-popover__filter-chip"
                        :class="{ 'mention-popover__filter-chip--active': mentionFilter === 'agents' }"
                        role="tab"
                        :aria-selected="mentionFilter === 'agents'"
                        @mousedown.prevent="setMentionFilter('agents')"
                    >
                        <i class="pi pi-user" /> agents
                    </button>
                    <button
                        type="button"
                        class="mention-popover__filter-chip"
                        :class="{ 'mention-popover__filter-chip--active': mentionFilter === 'projects' }"
                        role="tab"
                        :aria-selected="mentionFilter === 'projects'"
                        @mousedown.prevent="setMentionFilter('projects')"
                    >
                        <i class="pi pi-folder" /> projects
                    </button>
                </div>
                <ul v-if="mentionSuggestions.length > 0" class="mention-popover__list">
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
                <div v-else class="mention-popover__empty">
                    no match in {{ mentionFilter === "all" ? "agents + projects" : mentionFilter }}
                </div>
            </div>
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
                :accept="UPLOAD_ACCEPT"
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
    border-radius: var(--radius-lg);
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--p-content-background);
}
/* #B.133: ticket-context header rendered at the top of the composer
   frame in top-down mode. Always visible (no disclosure widget) —
   same info, same presentation as the non-topdown .thread-ticket
   header. Separator under it so it visually reads as a header strip,
   not part of the composer fields. */
.composer-headline {
    margin: -0.4rem -0.4rem 0;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--p-content-border-color);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
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
    border-radius: var(--radius-md);
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
    border-radius: var(--radius-sm);
    font-size: var(--fs-lg);
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
    font-family: var(--font-mono);
    color: var(--p-text-color);
}
.mention-popover__kind {
    font-size: var(--fs-xs);
    color: var(--p-text-muted-color);
}
/* #515 — bandeau filtre par catégorie (all / agents / projects). */
.mention-popover__filters {
    display: flex;
    gap: 0.25rem;
    padding: 0.15rem 0.25rem 0.3rem;
    border-bottom: 1px solid var(--p-content-border-color);
    margin-bottom: 0.15rem;
}
.mention-popover__filter-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--p-text-muted-color);
    font-size: var(--fs-xs);
    cursor: pointer;
    transition: background 120ms, color 120ms, border-color 120ms;
}
.mention-popover__filter-chip i {
    font-size: 0.85em;
}
.mention-popover__filter-chip:hover {
    background: color-mix(in srgb, var(--p-primary-color) 8%, transparent);
}
.mention-popover__filter-chip--active {
    background: color-mix(in srgb, var(--p-primary-color) 18%, transparent);
    border-color: var(--p-primary-color);
    color: var(--p-primary-color);
    font-weight: 600;
}
.mention-popover__list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
}
.mention-popover__empty {
    padding: 0.4rem 0.5rem;
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
    font-style: italic;
}
.composer-meta {
    display: flex;
    gap: 0.6rem;
    align-items: center;
}
.composer-scope {
    min-width: 9rem;
}
/* #514 — assignee picker à côté du scope, mêmes dimensions. */
.composer-assignee {
    min-width: 9rem;
}
.composer-scope-option {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
}
.composer-title-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}
/* #292: tag-picker row in the new-ticket composer. */
.composer-tags-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
}
.composer-tags-label {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
}
.composer-title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
}
/* Narrow viewports: stack title + intent select instead of
   overflowing past the right edge (#B.188). */
@media (max-width: 720px) {
    .composer-title-row {
        flex-direction: column;
        align-items: stretch;
    }
    .composer-title-row .p-select {
        width: 100%;
        min-width: 0;
    }
}
.composer-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
}
.composer-hint {
    font-size: var(--fs-sm);
    color: var(--p-text-muted-color);
    line-height: 1.3;
}
.composer-preview {
    border: 1px dashed var(--p-content-border-color);
    border-radius: var(--radius-md);
    padding: 0.8rem;
    min-height: 5rem;
}
.composer-textarea-wrap {
    width: 100%;
}
.composer-textarea {
    width: 100%;
    min-height: 10rem;
    font-family: var(--font-mono);
    font-size: var(--fs-lg);
    resize: vertical;
}
.spacer { flex: 1; }

/* #609 david `3rhsxf` + `v9j6nw` : le composer (zone détail du message
   en bas du thread, OU en haut en top-down mode) garde encore ses
   bordures gauche/droite en mobile → look "card" alors que le reste
   de la liste est edge-to-edge. On drop left/right border + radius
   pour s'aligner sur le pattern flat smartphone. Top + bottom restent
   (cohérent avec la séparation horizontale du thread). Padding interne
   conservé pour le texte. `!important` parce que la specificity de
   `.composer { border: 1px solid }` est égale + david rapporte que le
   premier fix ne prenait pas (probable cache + soyons safe). */
@media (max-width: 720px) {
    .composer {
        border-left: none !important;
        border-right: none !important;
        border-radius: 0 !important;
    }
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import { useToast } from "primevue/usetoast";
import MarkdownView from "./MarkdownView.vue";
import { INTENTS, type Intent } from "../lib/api";
import { bus } from "../lib/bus";
import { attachPasteImage } from "../lib/pasteImage";

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
 * composer finished" (e.g. close a modal). Data refresh is on the bus
 * — this emit is purely a parent-coupling UX signal.
 */
const emit = defineEmits<{ (e: "submitted"): void }>();

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
        const payload = isTicket.value
            ? {
                project: props.project,
                kind: "ticket_created",
                title: title.value.trim(),
                body: body.value,
                intent: intent.value,
                by_agent: byAgent.value || "human",
            }
            : {
                project: props.project,
                kind: "comment_added",
                ticket_id: props.ticketId,
                parent_id: props.parentId ?? props.ticketId,
                body: body.value,
                by_agent: byAgent.value || "human",
            };
        const res = await fetch("/api/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
        // Successful post → drop the persisted draft, reset local state.
        sessionStorage.removeItem(draftKey.value);
        title.value = "";
        body.value = "";
        preview.value = false;
        // Refresh fan-out: WS will fire for everyone, but emitting
        // locally now makes the sender's UI feel instant.
        if (props.ticketId !== undefined) {
            bus.emit("thread.refresh", { ticketId: props.ticketId });
        }
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
        emit("submitted");
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
});
onBeforeUnmount(() => {
    detachPaste?.();
});
</script>

<template>
    <div class="composer">
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
                @keydown.ctrl.enter.prevent="submit"
                @keydown.meta.enter.prevent="submit"
            />
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

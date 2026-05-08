<script setup lang="ts">
import { computed, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import MarkdownView from "./MarkdownView.vue";
import { PRIORITIES, type Priority } from "../lib/api";

type Mode = "ticket" | "comment";

const props = defineProps<{
    mode: Mode;
    project: string;
    ticketId?: number;
    parentId?: number | null;
    placeholder?: string;
    submitLabel?: string;
}>();
const emit = defineEmits<{ (e: "submitted"): void }>();

const title = ref("");
const body = ref("");
const byAgent = ref(localStorage.getItem("aiball.human_id") ?? "human");
const priority = ref<Priority>("request");
const preview = ref(false);
const sending = ref(false);
const error = ref<string | null>(null);

const priorityOptions = PRIORITIES.map((p) => ({
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
                priority: priority.value,
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
        title.value = "";
        body.value = "";
        preview.value = false;
        emit("submitted");
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        sending.value = false;
    }
}
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
                v-model="priority"
                :options="priorityOptions"
                option-label="label"
                option-value="value"
                size="small"
                :disabled="sending"
                style="min-width: 9rem"
            />
        </div>
        <div v-if="!preview" class="composer-textarea-wrap">
            <Textarea
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
        <div class="composer-actions">
            <span style="font-size: 0.8rem; color: var(--p-text-muted-color)">
                supports
                <strong>**bold**</strong>, <em>*italic*</em>, <code>`code`</code>,
                lists, links, fenced ```code blocks```
            </span>
            <span class="spacer" />
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
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
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

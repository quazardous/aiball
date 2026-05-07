<script setup lang="ts">
import { ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import MarkdownView from "./MarkdownView.vue";

const props = defineProps<{
    project: string;
    ticketId: number;
    parentId?: number | null;
    placeholder?: string;
}>();
const emit = defineEmits<{ (e: "submitted"): void }>();

const body = ref("");
const byAgent = ref(localStorage.getItem("aiball.human_id") ?? "human");
const preview = ref(false);
const sending = ref(false);
const error = ref<string | null>(null);

async function submit() {
    if (!body.value.trim()) return;
    sending.value = true;
    error.value = null;
    try {
        localStorage.setItem("aiball.human_id", byAgent.value);
        const res = await fetch("/api/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                project: props.project,
                kind: "comment_added",
                ticket_id: props.ticketId,
                parent_id: props.parentId ?? props.ticketId,
                body: body.value,
                by_agent: byAgent.value || "human",
            }),
        });
        if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
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
    <div class="reply-box">
        <div class="reply-meta">
            <span class="field-label" style="margin: 0">replying as</span>
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
        <div v-if="!preview" class="reply-textarea-wrap">
            <Textarea
                v-model="body"
                :rows="8"
                class="w-full reply-textarea"
                :placeholder="placeholder ?? 'Write a comment — markdown supported (gfm)'"
                :disabled="sending"
                autoResize
                @keydown.ctrl.enter.prevent="submit"
                @keydown.meta.enter.prevent="submit"
            />
        </div>
        <div v-else class="reply-preview">
            <MarkdownView :source="body" />
            <div v-if="!body.trim()" class="aiball-empty" style="padding: 1rem">
                Nothing to preview.
            </div>
        </div>
        <div class="reply-actions">
            <span style="font-size: 0.8rem; color: var(--p-text-muted-color)">
                supports
                <strong>**bold**</strong>, <em>*italic*</em>, <code>`code`</code>,
                lists, links, fenced ```code blocks```
            </span>
            <span class="spacer" />
            <Button
                label="post comment"
                icon="pi pi-send"
                size="small"
                :loading="sending"
                :disabled="!body.trim()"
                @click="submit"
            />
        </div>
        <div v-if="error" style="color: var(--p-red-500); font-size: 0.85rem">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style>
.reply-box {
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    background: var(--p-content-background);
}
.reply-meta {
    display: flex;
    gap: 0.6rem;
    align-items: center;
}
.reply-actions {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
}
.reply-preview {
    border: 1px dashed var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.8rem;
    min-height: 5rem;
}
.reply-textarea-wrap {
    width: 100%;
}
.reply-textarea {
    width: 100%;
    min-height: 10rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9rem;
    resize: vertical;
}
.spacer { flex: 1; }
</style>

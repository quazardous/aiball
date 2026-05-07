<script setup lang="ts">
import { ref, computed } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import Tag from "primevue/tag";
import { api, type Message } from "../lib/api";
import MarkdownView from "./MarkdownView.vue";

const props = defineProps<{ message: Message }>();
const emit = defineEmits<{ (e: "changed", m: Message): void }>();

const editing = ref(false);
const editTitle = ref("");
const editBody = ref("");
const editPreview = ref(false);
const noting = ref(false);
const note = ref("");
const busy = ref(false);
const error = ref<string | null>(null);

const displayTitle = computed(
    () => props.message.edited_title ?? props.message.title ?? "",
);
const displayBody = computed(
    () => props.message.edited_body ?? props.message.body ?? "",
);

const statusSeverity = computed(() => {
    switch (props.message.status) {
        case "approved":
            return "success";
        case "rejected":
            return "danger";
        default:
            return "warn";
    }
});

const kindLabel = computed(() => {
    switch (props.message.kind) {
        case "ticket_created":
            return "ticket";
        case "comment_added":
            return "comment";
        case "ticket_closed":
            return "close";
    }
    return props.message.kind;
});

async function call<T>(fn: () => Promise<T>): Promise<T | null> {
    busy.value = true;
    error.value = null;
    try {
        return await fn();
    } catch (e) {
        error.value = (e as Error).message;
        return null;
    } finally {
        busy.value = false;
    }
}

async function approve() {
    const r = await call(() => api.approve(props.message.id));
    if (r) emit("changed", r);
}
async function reject() {
    const r = await call(() => api.reject(props.message.id));
    if (r) emit("changed", r);
}

function startEdit() {
    editTitle.value = displayTitle.value;
    editBody.value = displayBody.value;
    editPreview.value = false;
    editing.value = true;
}
async function saveEdit() {
    const payload: { title?: string; body?: string } = {};
    if (editTitle.value !== displayTitle.value) payload.title = editTitle.value;
    if (editBody.value !== displayBody.value) payload.body = editBody.value;
    if (Object.keys(payload).length === 0) {
        editing.value = false;
        return;
    }
    const r = await call(() => api.edit(props.message.id, payload));
    if (r) {
        emit("changed", r);
        editing.value = false;
    }
}

function startNote() {
    note.value = props.message.human_note ?? "";
    noting.value = true;
}
async function saveNote() {
    const r = await call(() =>
        api.note(props.message.id, note.value.length ? note.value : null),
    );
    if (r) {
        emit("changed", r);
        noting.value = false;
    }
}
</script>

<template>
    <div class="message-card">
        <div class="meta">
            <Tag :value="`#${message.id}`" severity="secondary" />
            <Tag :value="kindLabel" />
            <Tag :value="message.project" severity="info" />
            <Tag :value="message.status" :severity="statusSeverity" />
            <span v-if="message.by_agent">by {{ message.by_agent }}</span>
            <span v-if="message.ticket_id">→ ticket #{{ message.ticket_id }}</span>
            <span class="spacer" />
            <span :title="message.created_at">{{
                new Date(message.created_at).toLocaleString()
            }}</span>
        </div>

        <div v-if="!editing">
            <div v-if="displayTitle" class="title">{{ displayTitle }}</div>
            <MarkdownView v-if="displayBody" :source="displayBody" />
        </div>
        <div v-else class="edit-form">
            <span class="field-label">Title</span>
            <InputText v-model="editTitle" class="w-full" :disabled="busy" />
            <div style="display: flex; align-items: center; gap: 0.5rem">
                <span class="field-label" style="margin: 0">Body (markdown)</span>
                <span class="spacer" />
                <ToggleButton
                    v-model="editPreview"
                    on-label="edit"
                    off-label="preview"
                    on-icon="pi pi-pencil"
                    off-icon="pi pi-eye"
                    size="small"
                />
            </div>
            <Textarea
                v-if="!editPreview"
                v-model="editBody"
                :rows="6"
                class="w-full"
                :disabled="busy"
                style="font-family: ui-monospace, monospace; font-size: 0.9rem"
            />
            <div v-else class="reply-preview">
                <MarkdownView :source="editBody" />
                <div v-if="!editBody.trim()" class="aiball-empty" style="padding: 1rem">
                    Nothing to preview.
                </div>
            </div>
            <div class="actions">
                <Button
                    label="save"
                    icon="pi pi-check"
                    size="small"
                    :loading="busy"
                    @click="saveEdit"
                />
                <Button
                    label="cancel"
                    icon="pi pi-times"
                    size="small"
                    severity="secondary"
                    text
                    @click="editing = false"
                />
            </div>
        </div>

        <div v-if="message.human_note && !noting" class="meta">
            <i class="pi pi-comment" />
            <em>{{ message.human_note }}</em>
        </div>
        <div v-if="noting" class="edit-form">
            <span class="field-label">Moderator note</span>
            <InputText v-model="note" :disabled="busy" />
            <div class="actions">
                <Button
                    label="save"
                    icon="pi pi-check"
                    size="small"
                    :loading="busy"
                    @click="saveNote"
                />
                <Button
                    label="cancel"
                    icon="pi pi-times"
                    size="small"
                    severity="secondary"
                    text
                    @click="noting = false"
                />
            </div>
        </div>

        <div v-if="!editing && !noting" class="actions">
            <template v-if="message.status === 'pending'">
                <Button
                    label="approve"
                    icon="pi pi-check"
                    size="small"
                    severity="success"
                    :loading="busy"
                    @click="approve"
                />
                <Button
                    label="reject"
                    icon="pi pi-times"
                    size="small"
                    severity="danger"
                    :loading="busy"
                    @click="reject"
                />
                <Button
                    label="edit"
                    icon="pi pi-pencil"
                    size="small"
                    severity="secondary"
                    text
                    :disabled="busy"
                    @click="startEdit"
                />
            </template>
            <Button
                :label="message.human_note ? 'edit note' : 'add note'"
                icon="pi pi-comment"
                size="small"
                severity="secondary"
                text
                :disabled="busy"
                @click="startNote"
            />
        </div>

        <div v-if="error" class="meta" style="color: var(--p-red-500)">
            <i class="pi pi-exclamation-triangle" />
            {{ error }}
        </div>
    </div>
</template>

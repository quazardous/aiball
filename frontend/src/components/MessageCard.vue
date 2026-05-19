<script setup lang="ts">
import { computed, inject, ref, type Ref } from "vue";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import ToggleButton from "primevue/togglebutton";
import Tag from "primevue/tag";
import { api, type Message } from "../lib/api";
import { KIND_ICONS, KIND_LABELS, STATUS_SEVERITY } from "../lib/labels";
import { scopeIcon, scopeTitle, type Scope } from "../lib/scope";
import MarkdownView from "./MarkdownView.vue";
import ListRow from "./ListRow.vue";
import TagBadge from "./TagBadge.vue";
import TagPicker from "./TagPicker.vue";

const props = defineProps<{
    message: Message;
    selectable?: boolean;
    selected?: boolean;
}>();
const emit = defineEmits<{
    (e: "changed", m: Message): void;
    (e: "update:selected", v: boolean): void;
}>();

const compactMode = inject<Ref<boolean>>("compact", ref(false));

const editing = ref(false);
const editTitle = ref("");
const editBody = ref("");
const editPreview = ref(false);
const noting = ref(false);
const note = ref("");
const busy = ref(false);
const error = ref<string | null>(null);
const expanded = ref(false);

// In comfortable mode the full card is always shown. In compact mode the
// row collapses to a single Gmail-style line, but expands inline if the
// user clicks it or starts editing/noting.
const showFull = computed(() => {
    if (!compactMode.value) return true;
    return expanded.value || editing.value || noting.value;
});

const displayTitle = computed(
    () => props.message.edited_title ?? props.message.title ?? "",
);
const displayBody = computed(
    () => props.message.edited_body ?? props.message.body ?? "",
);

function snippet(s: string, n = 120): string {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n) + "…" : flat;
}
const bodySnippet = computed(() => snippet(displayBody.value));

function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m`;
    if (diff < day) return `${Math.floor(diff / hr)}h`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
    return d.toLocaleDateString();
}

// Pull severities + kind labels from the central catalog so adding a
// new MessageKind only happens in labels.ts (#B.122).
const statusSeverity = computed(() => STATUS_SEVERITY[props.message.status]);
const kindLabel = computed(() => KIND_LABELS[props.message.kind] ?? props.message.kind);
const kindIcon = computed(() => KIND_ICONS[props.message.kind] ?? "pi pi-circle");

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
    <!-- Compact (Gmail-style) row when collapsed -->
    <ListRow
        v-if="!showFull"
        :selected="selectable && selected"
        :unread="message.status === 'pending'"
        :danger="message.status === 'rejected'"
        @click="expanded = true"
    >
        <template #select>
            <Checkbox
                v-if="selectable"
                :model-value="selected"
                binary
                @update:model-value="(v: boolean) => emit('update:selected', v)"
            />
        </template>
        <template #lead>
            <i :class="kindIcon" style="color: var(--p-text-muted-color)" />
        </template>
        <template v-if="message.by_agent" #from>
            {{ message.by_agent }}
        </template>
        <template #title>
            <span class="msg-id">#{{ message.id }}</span>
            <!-- #B.245: per-event scope badge (internal / broadcast).
                 Same glyph & semantics as the inbox list — only
                 surfaces non-default scopes to keep the common case
                 visually quiet. -->
            <i
                v-if="message.scope && message.scope !== 'default' && scopeIcon(message.scope as Scope)"
                :class="['pi', scopeIcon(message.scope as Scope)]"
                :style="{
                    marginLeft: '0.3rem',
                    color: message.scope === 'broadcast' ? 'var(--p-blue-500)' : 'var(--p-text-muted-color)',
                    fontSize: '0.85rem',
                }"
                :title="scopeTitle(message.scope as Scope)"
            />
            <span v-if="displayTitle">{{ displayTitle }}</span>
            <span v-else style="color: var(--p-text-muted-color); font-style: italic">
                ({{ kindLabel }})
            </span>
            <TagBadge
                v-for="tg in message.tags"
                :key="tg.id"
                :tag="tg"
                size="sm"
                style="margin-left: 0.3rem"
            />
        </template>
        <template v-if="bodySnippet" #snippet>{{ bodySnippet }}</template>
        <template #meta>
            <Tag
                :value="message.status"
                :severity="statusSeverity"
                style="font-size: 0.7rem; padding: 0.05rem 0.35rem"
            />
        </template>
        <template #time>{{ relativeTime(message.created_at) }}</template>
        <template #actions>
            <Button
                v-if="message.status === 'pending'"
                icon="pi pi-check"
                severity="success"
                size="small"
                rounded
                text
                title="approve"
                :loading="busy"
                @click="approve"
            />
            <Button
                v-if="message.status === 'pending'"
                icon="pi pi-times"
                severity="danger"
                size="small"
                rounded
                text
                title="reject"
                :loading="busy"
                @click="reject"
            />
            <Button
                v-if="message.status === 'pending'"
                icon="pi pi-pencil"
                severity="secondary"
                size="small"
                rounded
                text
                title="edit"
                @click="startEdit"
            />
            <Button
                icon="pi pi-comment"
                severity="secondary"
                size="small"
                rounded
                text
                :title="message.human_note ? 'edit note' : 'add note'"
                @click="startNote"
            />
            <Button
                icon="pi pi-arrow-down"
                severity="secondary"
                size="small"
                rounded
                text
                title="expand"
                @click="expanded = true"
            />
        </template>
    </ListRow>

    <!-- Full card when expanded or in comfortable mode -->
    <div
        v-else
        class="message-card"
        :class="{ 'is-selected': selectable && selected, 'is-expanded': expanded }"
    >
        <div class="meta" @click="compactMode && (expanded = !expanded)" :style="compactMode ? 'cursor: pointer' : ''">
            <Checkbox
                v-if="selectable"
                :model-value="selected"
                binary
                @update:model-value="(v: boolean) => emit('update:selected', v)"
                @click.stop
            />
            <i
                v-if="compactMode"
                class="pi expand-chevron pi-chevron-down"
            />
            <Tag
                :value="message.kind === 'ticket_created'
                    ? `#B.${message.id}`
                    : `#C.${message.hashid ?? message.id}`"
                severity="secondary"
            />
            <Tag :value="kindLabel" />
            <Tag :value="message.project" severity="info" />
            <Tag :value="message.status" :severity="statusSeverity" />
            <span v-if="message.by_agent">by {{ message.by_agent }}</span>
            <span v-if="message.ticket_id">→ #B.{{ message.ticket_id }}</span>
            <span class="spacer" />
            <span :title="message.created_at">{{
                new Date(message.created_at).toLocaleString()
            }}</span>
        </div>

        <div v-if="!editing">
            <div v-if="displayTitle" class="title">{{ displayTitle }}</div>
            <MarkdownView v-if="displayBody" :source="displayBody" />
            <div v-if="message.tags.length" class="card-tags">
                <TagBadge
                    v-for="tg in message.tags"
                    :key="tg.id"
                    :tag="tg"
                    size="sm"
                />
            </div>
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
                :rows="8"
                class="w-full"
                :disabled="busy"
                style="font-family: ui-monospace, monospace; font-size: 0.9rem; min-height: 10rem; resize: vertical"
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
            <InputText v-model="note" class="w-full" :disabled="busy" />
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
            <span v-if="compactMode" class="spacer" />
            <Button
                v-if="compactMode"
                label="collapse"
                icon="pi pi-chevron-up"
                size="small"
                severity="secondary"
                text
                @click="expanded = false"
            />
        </div>

        <div v-if="!editing && !noting" class="card-tag-picker">
            <span class="field-label" style="margin: 0">tags</span>
            <TagPicker
                :message-id="message.id"
                :tags="message.tags"
                set-by="human"
                @changed="(tags) => emit('changed', { ...message, tags })"
            />
        </div>

        <div v-if="error" class="meta" style="color: var(--p-red-500)">
            <i class="pi pi-exclamation-triangle" />
            {{ error }}
        </div>
    </div>
</template>

<style>
.msg-id {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85em;
    margin-right: 0.4rem;
}
.card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.4rem;
}
.card-tag-picker {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--p-content-border-color);
}
</style>

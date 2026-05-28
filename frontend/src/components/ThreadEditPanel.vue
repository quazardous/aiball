<script setup lang="ts">
/**
 * Inline edit panel for the ticket title + body + intent + tags (#B.196
 * Layer 3 extract from ThreadView). Mounted under `v-if="editing"` in
 * the parent; state lives in the parent (titleDraft / bodyDraft / busy
 * flags / save & cancel handlers) and the child is pure UI + v-model.
 *
 * Exposes `bodyTextareaRef` via defineExpose so the parent can attach
 * its paste-image handler to the textarea DOM node (the textarea is
 * mounted/unmounted with this panel — the parent watches the ref and
 * (re)attaches on mount).
 */
import { ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import TagPicker from "./TagPicker.vue";
import type { Intent, Priority, Tag as TagType, TicketSummary } from "../lib/api";
import { PRIORITIES } from "../lib/api";

defineProps<{
    ticket: TicketSummary;
    titleDraft: string;
    bodyDraft: string;
    bodyBusy: boolean;
    intentBusy: boolean;
    intentOptions: { label: string; value: Intent | null }[];
    /** Optional — when the parent doesn't pass this we synthesize a default
     *  list at the bottom of the script so existing callsites don't have to
     *  be touched to surface the priority editor. */
    priorityOptions?: { label: string; value: Priority | null }[];
    priorityBusy?: boolean;
    /** #553 — scope busy flag (driven by parent). */
    scopeBusy?: boolean;
}>();
const emit = defineEmits<{
    (e: "update:titleDraft", v: string): void;
    (e: "update:bodyDraft", v: string): void;
    (e: "save"): void;
    (e: "cancel"): void;
    (e: "intent-change", v: Intent | null): void;
    (e: "priority-change", v: Priority | null): void;
    /** #553 — emitted when the user changes the ticket-level scope. */
    (e: "scope-change", v: "internal" | "default" | "broadcast"): void;
    (e: "tags-changed", tags: TagType[]): void;
}>();

// Default priority options synthesized here so the parent doesn't have
// to thread them through — mirrors what intentOptions used to do before
// the parent started passing them explicitly.
const defaultPriorityOptions: { label: string; value: Priority | null }[] =
    PRIORITIES.map((p) => ({ label: p, value: p }));

// #553 — scope options (#B.245 tristate). Internal = owners + @mentions
// only ; default = subscribers + project owners + @mentions ; broadcast =
// default + project followers. Tickets only (per-comment scope retiré du
// composer côté #553 `8864778`).
const scopeOptions: { label: string; value: "internal" | "default" | "broadcast" }[] = [
    { label: "internal", value: "internal" },
    { label: "default", value: "default" },
    { label: "broadcast", value: "broadcast" },
];

const bodyTextareaRef = ref<{ $el?: HTMLTextAreaElement } | null>(null);
defineExpose({ bodyTextareaRef });
</script>

<template>
    <div class="thread-edit-panel">
        <div class="thread-edit-row">
            <span class="thread-edit-label">Title</span>
            <InputText
                :model-value="titleDraft"
                :disabled="bodyBusy"
                size="small"
                style="flex: 1"
                placeholder="Ticket title"
                @update:model-value="(v) => emit('update:titleDraft', String(v ?? ''))"
                @keydown.enter.prevent="emit('save')"
            />
        </div>
        <div class="thread-edit-row">
            <span class="thread-edit-label">Body</span>
            <Textarea
                ref="bodyTextareaRef"
                :model-value="bodyDraft"
                :disabled="bodyBusy"
                :rows="6"
                autoResize
                style="flex: 1; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.9rem;"
                placeholder="Ticket body (markdown supported, leave blank to clear)"
                @update:model-value="(v) => emit('update:bodyDraft', String(v ?? ''))"
                @keydown.ctrl.enter.prevent="emit('save')"
                @keydown.meta.enter.prevent="emit('save')"
                @keydown.escape.prevent="emit('cancel')"
            />
        </div>
        <!-- #377: intent + priority side by side on desktop, stacked on
             smartphone (one widget per line). -->
        <div class="thread-edit-pair">
            <div class="thread-edit-row">
                <span class="thread-edit-label">Intent</span>
                <Select
                    :model-value="ticket.intent"
                    :options="intentOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    :disabled="intentBusy"
                    style="min-width: 9rem"
                    @update:model-value="(v: Intent | null) => emit('intent-change', v)"
                />
            </div>
            <div class="thread-edit-row">
                <span class="thread-edit-label">Priority</span>
                <Select
                    :model-value="ticket.priority ?? 'normal'"
                    :options="priorityOptions ?? defaultPriorityOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    :disabled="priorityBusy"
                    style="min-width: 9rem"
                    @update:model-value="(v: Priority | null) => emit('priority-change', v)"
                />
            </div>
            <!-- #553 david `3r3vjq` : scope éditable depuis l'edit panel (à
                 côté de priority). Per-comment scope retiré du composer
                 (cf. `8864778`) ; le scope ticket-level pilote le fan-out
                 par défaut des events futurs. -->
            <div class="thread-edit-row">
                <span class="thread-edit-label">Scope</span>
                <Select
                    :model-value="ticket.scope ?? 'default'"
                    :options="scopeOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    :disabled="scopeBusy"
                    style="min-width: 9rem"
                    @update:model-value="(v: 'internal' | 'default' | 'broadcast') => emit('scope-change', v)"
                />
            </div>
        </div>
        <div class="thread-edit-row">
            <span class="thread-edit-label">Tags</span>
            <TagPicker
                :message-id="ticket.id"
                :tags="ticket.tags"
                @changed="(tags) => emit('tags-changed', tags)"
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
                @click="emit('cancel')"
            />
            <Button
                label="save"
                icon="pi pi-check"
                size="small"
                severity="success"
                :loading="bodyBusy"
                @click="emit('save')"
            />
        </div>
    </div>
</template>

<style src="./ThreadEditPanel.css" scoped></style>

<script setup lang="ts">
/**
 * Dedicated edit page for a single consumer (#B.193 item 3).
 *
 * Rendered by ConsumersPanel when the parent route is /consumers/<id>.
 * Same fields as the inline row editor (kind, display_name, enabled,
 * note) but with more room — and a single save action so all changes
 * land atomically.
 */
import { ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { useToast } from "primevue/usetoast";
import { api, CONSUMER_KIND_OPTIONS, type Consumer, type ConsumerKind } from "../lib/api";
import { relativeTime } from "../lib/format";
import FieldRow from "./ui/FieldRow.vue";
import DetailHeader from "./ui/DetailHeader.vue";

const props = defineProps<{ consumerId: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const toast = useToast();
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const original = ref<Consumer | null>(null);

const kind = ref<ConsumerKind>("agent");
const displayName = ref("");
const note = ref("");
const microPrompt = ref("");
const enabled = ref(true);
// #451: raw-prompt injection (this dedicated page is where the operator types it).
const promptText = ref("");
const promptBusy = ref(false);

const KIND_OPTIONS = CONSUMER_KIND_OPTIONS;

async function load() {
    loading.value = true;
    error.value = null;
    try {
        // We reuse the full-list endpoint and filter client-side (cost is
        // small — a few hundred rows max). A per-id GET exists since #397
        // (used by the claude-loop wake builder) but the list already carries
        // `micro_prompt`, so there's no need for a second round-trip here.
        const all = await api.listConsumers();
        const found = all.find((c) => c.consumer_id === props.consumerId);
        if (!found) {
            error.value = `Consumer "${props.consumerId}" not found.`;
            return;
        }
        original.value = found;
        kind.value = found.kind;
        displayName.value = found.display_name ?? "";
        note.value = found.note ?? "";
        microPrompt.value = found.micro_prompt ?? "";
        enabled.value = found.enabled;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.consumerId, load, { immediate: true });

async function save() {
    if (!original.value) return;
    saving.value = true;
    try {
        await api.updateConsumer(props.consumerId, {
            kind: kind.value,
            display_name: displayName.value.trim() || null,
            note: note.value.trim() || null,
            micro_prompt: microPrompt.value.trim() || null,
            enabled: enabled.value,
        });
        toast.add({
            severity: "success",
            summary: `Saved ${props.consumerId}`,
            life: 3000,
        });
        emit("close");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Save failed",
            detail: (e as Error).message,
            life: 6000,
        });
    } finally {
        saving.value = false;
    }
}

// #451: send a raw, unfiltered prompt to this loop. Spooled then delivered:
// live → injected now; offline → delivered when the loop's SSE reconnects.
async function sendPrompt() {
    const text = promptText.value.trim();
    if (!text) return;
    promptBusy.value = true;
    try {
        const r = await api.sendLoopPrompt(props.consumerId, text);
        toast.add({
            severity: r.delivered ? "success" : "info",
            summary: r.delivered ? `Prompt sent to ${props.consumerId}` : `Prompt spooled for ${props.consumerId}`,
            detail: r.delivered
                ? "Injected into the live Claude session."
                : "Loop offline — it'll be delivered when the loop reconnects.",
            life: 5000,
        });
        promptText.value = "";
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Prompt failed",
            detail: (e as Error).message,
            life: 6000,
        });
    } finally {
        promptBusy.value = false;
    }
}
</script>

<template>
    <div class="consumer-edit">
        <DetailHeader
            :crumbs="[{ label: 'Consumers' }]"
            :current="props.consumerId"
            title="Edit consumer"
            @crumb="emit('close')"
        />

        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty consumer-edit__error">
            <i class="pi pi-exclamation-triangle" />
            {{ error }}
        </div>
        <div v-else-if="original" class="consumer-edit__body">
            <FieldRow label="consumer_id">
                <span class="aiball-mono">{{ original.consumer_id }}</span>
            </FieldRow>

            <div class="consumer-edit__field">
                <label for="ce-kind">kind</label>
                <Select
                    inputId="ce-kind"
                    v-model="kind"
                    :options="KIND_OPTIONS"
                    optionLabel="label"
                    optionValue="value"
                    style="width: 100%"
                />
            </div>

            <div class="consumer-edit__field">
                <label for="ce-name">display name</label>
                <InputText
                    id="ce-name"
                    v-model="displayName"
                    placeholder="(falls back to consumer_id)"
                    style="width: 100%"
                />
            </div>

            <div class="consumer-edit__field">
                <label for="ce-note">note</label>
                <Textarea
                    id="ce-note"
                    v-model="note"
                    rows="3"
                    placeholder="(internal note — visible only on this page)"
                    style="width: 100%"
                />
            </div>

            <div class="consumer-edit__field">
                <label for="ce-micro-prompt">micro-prompt</label>
                <Textarea
                    id="ce-micro-prompt"
                    v-model="microPrompt"
                    rows="3"
                    placeholder="(standing instruction injected into this agent's wake prompt via {consumer_prompt} — e.g. &quot;branch main if the ticket doesn't specify&quot;)"
                    style="width: 100%"
                />
                <small class="consumer-edit__hint">
                    Surfaced to the agent on wake via the <code>{consumer_prompt}</code>
                    placeholder. Opt-in: add the placeholder to your <code>wake_master</code>
                    template (<code>.aiball.yaml</code>) where you want it. Empty = nothing injected.
                </small>
            </div>

            <div class="consumer-edit__field">
                <label>
                    <input
                        type="checkbox"
                        :checked="enabled"
                        @change="enabled = ($event.target as HTMLInputElement).checked"
                    />
                    enabled (when off, the daemon rejects new posts from this consumer)
                </label>
            </div>

            <!-- #451: raw-prompt injection (moderator-only, server-enforced). -->
            <div class="consumer-edit__field">
                <label for="ce-prompt">send a raw prompt</label>
                <Textarea
                    id="ce-prompt"
                    v-model="promptText"
                    rows="4"
                    :placeholder="original.present
                        ? 'Type a prompt — injected verbatim into the live Claude session…'
                        : 'Loop offline — the prompt will be spooled and delivered when it reconnects.'"
                    style="width: 100%"
                    :disabled="promptBusy"
                    @keydown.ctrl.enter="sendPrompt"
                />
                <small class="consumer-edit__hint">
                    Sent <strong>verbatim</strong> — no moderation, no wake-phrase.
                    {{ original.present
                        ? "Loop is live → delivered now."
                        : "Loop is offline → spooled until it reconnects." }}
                    Ctrl+Enter to send.
                </small>
                <div class="consumer-edit__actions">
                    <Button
                        label="Send prompt"
                        icon="pi pi-send"
                        size="small"
                        severity="secondary"
                        :loading="promptBusy"
                        :disabled="!promptText.trim()"
                        @click="sendPrompt"
                    />
                </div>
            </div>

            <div class="consumer-edit__meta">
                <div><strong>created</strong> {{ original.created_at ? relativeTime(original.created_at) : "—" }}</div>
                <div><strong>last seen</strong> {{ original.last_seen_at ? relativeTime(original.last_seen_at) : "never" }}</div>
            </div>

            <div class="consumer-edit__actions">
                <Button
                    label="Cancel"
                    text
                    size="small"
                    :disabled="saving"
                    @click="emit('close')"
                />
                <Button
                    label="Save"
                    icon="pi pi-save"
                    size="small"
                    :loading="saving"
                    @click="save"
                />
            </div>
        </div>
    </div>
</template>

<style>
.consumer-edit {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 36rem;
}
/* En-tête (breadcrumb + titre) → <DetailHeader> / `.aiball-detail-head*`
   + `.aiball-breadcrumb*` (style.css). */
.consumer-edit__error {
    color: var(--p-red-500);
}
.consumer-edit__body {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
}
.consumer-edit__field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.consumer-edit__field label {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.consumer-edit__hint {
    font-size: 0.78rem;
    line-height: 1.35;
    color: var(--p-text-muted-color);
}
.consumer-edit__hint code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.74rem;
}
/* consumer_id read-only → <FieldRow> + `.aiball-mono` (style.css). */
.consumer-edit__meta {
    display: flex;
    gap: 1.5rem;
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
.consumer-edit__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
}
</style>

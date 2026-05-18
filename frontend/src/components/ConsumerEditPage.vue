<script setup lang="ts">
/**
 * Dedicated edit page for a single consumer (#B.193 item 3).
 *
 * Rendered by ConsumersPanel when the parent route is /consumers/<id>.
 * Same fields as the inline row editor (kind, display_name, enabled,
 * note) but with more room — and a single save action so all changes
 * land atomically.
 */
import { onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Textarea from "primevue/textarea";
import { useToast } from "primevue/usetoast";
import { api, type Consumer, type ConsumerKind } from "../lib/api";
import { relativeTime } from "../lib/format";

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
const enabled = ref(true);

const KIND_OPTIONS = [
    { label: "Human", value: "human" as ConsumerKind },
    { label: "Agent", value: "agent" as ConsumerKind },
    { label: "Sandbox", value: "sandbox" as ConsumerKind },
];

async function load() {
    loading.value = true;
    error.value = null;
    try {
        // The /api/consumers endpoint returns the full list, so we filter
        // client-side. There's no per-id GET today; the cost is small (a
        // few hundred rows max in any realistic deployment).
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
        enabled.value = found.enabled;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.consumerId, load, { immediate: false });
onMounted(load);

async function save() {
    if (!original.value) return;
    saving.value = true;
    try {
        await api.updateConsumer(props.consumerId, {
            kind: kind.value,
            display_name: displayName.value.trim() || null,
            note: note.value.trim() || null,
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
</script>

<template>
    <div class="consumer-edit">
        <header class="consumer-edit__head">
            <Button
                label="Back to consumers"
                icon="pi pi-arrow-left"
                text
                size="small"
                @click="emit('close')"
            />
            <h2 class="consumer-edit__title">Edit consumer</h2>
        </header>

        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty consumer-edit__error">
            <i class="pi pi-exclamation-triangle" />
            {{ error }}
        </div>
        <div v-else-if="original" class="consumer-edit__body">
            <div class="consumer-edit__field">
                <label>consumer_id</label>
                <div class="consumer-edit__static">{{ original.consumer_id }}</div>
            </div>

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
                <label>
                    <input
                        type="checkbox"
                        :checked="enabled"
                        @change="enabled = ($event.target as HTMLInputElement).checked"
                    />
                    enabled (when off, the daemon rejects new posts from this consumer)
                </label>
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
.consumer-edit__head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.consumer-edit__title {
    margin: 0;
}
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
.consumer-edit__static {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.9rem;
    padding: 0.4rem 0.5rem;
    background: var(--p-surface-100);
    border-radius: 0.3rem;
}
.aiball-dark .consumer-edit__static {
    background: var(--p-surface-800);
}
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

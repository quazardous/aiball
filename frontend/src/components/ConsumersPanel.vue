<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { api, type Consumer, type ConsumerKind } from "../lib/api";

const toast = useToast();
const rows = ref<Consumer[]>([]);
const loading = ref(false);

// New-consumer form
const newId = ref("");
const newKind = ref<ConsumerKind>("agent");
const newName = ref("");

const KIND_OPTIONS = [
    { label: "Human", value: "human" as ConsumerKind },
    { label: "Agent", value: "agent" as ConsumerKind },
];

async function load() {
    loading.value = true;
    try {
        rows.value = await api.listConsumers();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load consumers",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        loading.value = false;
    }
}

async function patch(consumer_id: string, patchBody: Partial<Consumer>) {
    try {
        const updated = await api.updateConsumer(consumer_id, {
            kind: patchBody.kind,
            display_name: patchBody.display_name ?? null,
            enabled: patchBody.enabled,
            note: patchBody.note,
        });
        const idx = rows.value.findIndex((r) => r.consumer_id === consumer_id);
        if (idx >= 0) rows.value[idx] = updated;
    } catch (e) {
        toast.add({
            severity: "error",
            summary: `Update failed for ${consumer_id}`,
            detail: (e as Error).message,
            life: 6000,
        });
    }
}

async function create() {
    const id = newId.value.trim();
    if (!id) {
        toast.add({ severity: "warn", summary: "consumer_id required", life: 4000 });
        return;
    }
    try {
        const c = await api.upsertConsumer({
            consumer_id: id,
            kind: newKind.value,
            display_name: newName.value.trim() || null,
        });
        toast.add({
            severity: "success",
            summary: `Consumer "${c.consumer_id}" saved`,
            life: 4000,
        });
        newId.value = "";
        newName.value = "";
        newKind.value = "agent";
        await load();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Create failed",
            detail: (e as Error).message,
            life: 6000,
        });
    }
}

async function remove(consumer_id: string) {
    if (!confirm(`Delete consumer "${consumer_id}"? Past posts are preserved; the row will be re-created the next time this id posts.`)) return;
    try {
        await api.deleteConsumer(consumer_id);
        rows.value = rows.value.filter((r) => r.consumer_id !== consumer_id);
    } catch (e) {
        toast.add({
            severity: "error",
            summary: `Delete failed for ${consumer_id}`,
            detail: (e as Error).message,
            life: 6000,
        });
    }
}

onMounted(load);
</script>

<template>
    <div class="consumers-panel">
        <header class="rules-explainer-block">
            <h2 style="margin: 0">Consumers</h2>
            <p class="rules-explainer rules-explainer--muted">
                One row per <code>consumer_id</code> the daemon has seen — the same identity
                you pick in the header dropdown. <strong>Kind</strong> = <em>human</em>
                grants moderator bypass: posts skip moderation, can close / snooze any
                ticket, receives pings on every pending submission. <strong>display_name</strong>
                is the friendly label (falls back to the raw id). Blocking disables future
                writes without deleting history.
            </p>
            <p class="rules-explainer rules-explainer--muted">
                New ids are added automatically on first post. Promote one to <em>human</em>
                to make it the active moderator on this machine — and pair it with the
                header picker so the web UI sends the matching <code>X-Aiball-Consumer</code>
                header.
            </p>
        </header>

        <section class="consumers-new">
            <strong>Add consumer</strong>
            <InputText
                v-model="newId"
                placeholder="consumer_id"
                style="width: 14rem"
            />
            <Select
                v-model="newKind"
                :options="KIND_OPTIONS"
                optionLabel="label"
                optionValue="value"
                style="width: 8rem"
            />
            <InputText
                v-model="newName"
                placeholder="display name (optional)"
                style="width: 18rem"
            />
            <Button
                label="Save"
                icon="pi pi-plus"
                size="small"
                @click="create"
            />
        </section>

        <div v-if="loading && !rows.length" class="aiball-empty">Loading…</div>
        <div v-else-if="!rows.length" class="aiball-empty">
            <i class="pi pi-users" style="font-size: 1.6rem" />
            <div>No consumers yet — anyone who posts will be added here automatically.</div>
        </div>

        <table v-else class="consumers-table">
            <thead>
                <tr>
                    <th>Consumer id</th>
                    <th>Kind</th>
                    <th>Display name</th>
                    <th>State</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                <tr v-for="r in rows" :key="r.consumer_id" :class="{ 'is-blocked': !r.enabled }">
                    <td class="consumers-cid">
                        <div class="consumers-cid__inner">
                            <span class="consumers-cid__text">{{ r.consumer_id }}</span>
                            <Tag
                                v-if="r.kind === 'human'"
                                value="moderator"
                                severity="success"
                                class="consumers-cid__tag"
                            />
                        </div>
                    </td>
                    <td>
                        <Select
                            :model-value="r.kind"
                            :options="KIND_OPTIONS"
                            optionLabel="label"
                            optionValue="value"
                            @update:model-value="(v: ConsumerKind) => patch(r.consumer_id, { kind: v })"
                            style="width: 7rem"
                        />
                    </td>
                    <td>
                        <InputText
                            :model-value="r.display_name ?? ''"
                            @change="(e: Event) => patch(r.consumer_id, { display_name: (e.target as HTMLInputElement).value || null })"
                            placeholder="(uses id)"
                            style="width: 14rem"
                        />
                    </td>
                    <td>
                        <Button
                            :label="r.enabled ? 'Enabled' : 'Blocked'"
                            :severity="r.enabled ? 'success' : 'danger'"
                            text
                            size="small"
                            :title="r.enabled ? 'Click to block: future posts from this id will be refused' : 'Click to re-enable'"
                            @click="patch(r.consumer_id, { enabled: !r.enabled })"
                        />
                    </td>
                    <td class="action-cell">
                        <Button
                            icon="pi pi-trash"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            :title="`Delete consumer ${r.consumer_id} (history preserved)`"
                            @click="remove(r.consumer_id)"
                        />
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style>
.consumers-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.consumers-new {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
}
.consumers-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
}
.consumers-table th,
.consumers-table td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--p-content-border-color);
    vertical-align: middle;
    /* Pin row height so PrimeVue components with mildly different
       intrinsic heights (Select vs Button text vs Button rounded)
       can't drift between rows. */
    height: 3rem;
}
.consumers-cid {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
}
.consumers-cid__inner {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: nowrap;
    min-width: 0;
}
.consumers-cid__text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.consumers-cid__tag {
    font-size: 0.7rem;
    flex-shrink: 0;
}
.consumers-table tr.is-blocked {
    opacity: 0.55;
}
.action-cell {
    text-align: right;
}
</style>

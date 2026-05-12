<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { api, type Actor, type ActorKind } from "../lib/api";

const toast = useToast();
const rows = ref<Actor[]>([]);
const loading = ref(false);
// New-actor form state
const newId = ref("");
const newKind = ref<ActorKind>("agent");
const newName = ref("");

const KIND_OPTIONS = [
    { label: "Human", value: "human" as ActorKind },
    { label: "Agent", value: "agent" as ActorKind },
];

async function load() {
    loading.value = true;
    try {
        rows.value = await api.listActors();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load actors",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        loading.value = false;
    }
}

async function patch(consumer_id: string, patchBody: Partial<Actor>) {
    try {
        const updated = await api.updateActor(consumer_id, {
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
        const a = await api.upsertActor({
            consumer_id: id,
            kind: newKind.value,
            display_name: newName.value.trim() || null,
        });
        toast.add({
            severity: "success",
            summary: `Actor "${a.consumer_id}" saved`,
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
    if (!confirm(`Delete actor "${consumer_id}"? Past posts are preserved.`)) return;
    try {
        await api.deleteActor(consumer_id);
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
    <div class="actors-panel">
        <header class="rules-explainer-block">
            <h2 style="margin: 0">Actors</h2>
            <p class="rules-explainer rules-explainer--muted">
                Every consumer_id the daemon has seen, with its kind (human or agent), display name, and
                enabled flag. Tagging an actor <strong>human</strong> grants moderator bypass —
                their posts skip moderation and they can close / snooze any ticket. New
                consumer_ids are added automatically the first time they post.
            </p>
        </header>

        <div class="actors-new">
            <strong>Add actor</strong>
            <InputText v-model="newId" placeholder="consumer_id" style="width: 14rem" />
            <Select v-model="newKind" :options="KIND_OPTIONS" optionLabel="label" optionValue="value" style="width: 8rem" />
            <InputText v-model="newName" placeholder="display name (optional)" style="width: 18rem" />
            <Button label="Save" icon="pi pi-plus" size="small" @click="create" />
        </div>

        <div v-if="loading && !rows.length" class="aiball-empty">Loading…</div>
        <div v-else-if="!rows.length" class="aiball-empty">
            <i class="pi pi-users" style="font-size: 1.6rem" />
            <div>No actors yet — anyone who posts will be added automatically.</div>
        </div>

        <table v-else class="actors-table">
            <thead>
                <tr>
                    <th>Consumer id</th>
                    <th>Kind</th>
                    <th>Display name</th>
                    <th>Enabled</th>
                    <th />
                </tr>
            </thead>
            <tbody>
                <tr v-for="r in rows" :key="r.consumer_id">
                    <td class="actors-cid">{{ r.consumer_id }}</td>
                    <td>
                        <Select
                            :model-value="r.kind"
                            :options="KIND_OPTIONS"
                            optionLabel="label"
                            optionValue="value"
                            @update:model-value="(v: ActorKind) => patch(r.consumer_id, { kind: v })"
                            style="width: 7rem"
                        />
                        <Tag
                            v-if="r.kind === 'human'"
                            value="moderator"
                            severity="success"
                            style="margin-left: 0.4rem; font-size: 0.7rem"
                        />
                    </td>
                    <td>
                        <InputText
                            :model-value="r.display_name ?? ''"
                            @change="(e: Event) => patch(r.consumer_id, { display_name: (e.target as HTMLInputElement).value || null })"
                            placeholder="(none)"
                            style="width: 14rem"
                        />
                    </td>
                    <td>
                        <Button
                            :label="r.enabled ? 'Enabled' : 'Blocked'"
                            :severity="r.enabled ? 'success' : 'danger'"
                            text
                            size="small"
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
                            title="Delete this actor"
                            @click="remove(r.consumer_id)"
                        />
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style>
.actors-panel {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}
.actors-new {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
}
.actors-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.92rem;
}
.actors-table th,
.actors-table td {
    text-align: left;
    padding: 0.5rem 0.6rem;
    border-bottom: 1px solid var(--p-content-border-color);
}
.actors-cid {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
}
.action-cell {
    text-align: right;
}
</style>

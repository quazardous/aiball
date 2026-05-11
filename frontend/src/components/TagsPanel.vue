<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { api, type Tag } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import TagBadge from "./TagBadge.vue";

const tags = ref<Tag[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const editingId = ref<number | null>(null);

const newName = ref("");
const newColor = ref("#3b82f6");
const newNote = ref("");

async function load() {
    loading.value = true;
    try {
        tags.value = await api.listTags();
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

async function add() {
    if (!newName.value.trim()) return;
    try {
        await api.addTag({
            name: newName.value.trim(),
            color: newColor.value || undefined,
            note: newNote.value.trim() || undefined,
        });
        newName.value = "";
        newColor.value = "#3b82f6";
        newNote.value = "";
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function save(t: Tag, fields: Partial<Tag>) {
    try {
        await api.updateTag(t.id, fields);
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(t: Tag) {
    if (!confirm(`Delete tag '${t.name}'? Any message currently tagged loses it.`))
        return;
    try {
        await api.delTag(t.id);
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

// Self-refresh on bus events (WS-driven or local mutations).
useBus("tags.refresh", () => load());
onMounted(load);
</script>

<template>
    <div class="tags-page">
        <header>
            <h2>Tags</h2>
            <p class="rules-explainer">
                Tags are a <strong>closed list</strong>: you (the human moderator) define what
                tags exist. Agents can only apply existing tags — they can't invent new ones.
                Use them to group tickets (bug / feature / urgent / done) and as a hook for
                automation rules later on.
            </p>
        </header>

        <section class="rules-section">
            <div class="rules-section-head">
                <h3>Catalog ({{ tags.length }})</h3>
            </div>

            <div v-if="!tags.length" class="aiball-empty">No tags defined yet.</div>

            <table v-else class="tags-table">
                <thead>
                    <tr>
                        <th>preview</th>
                        <th>name</th>
                        <th>color</th>
                        <th>note</th>
                        <th>order</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="t in tags" :key="t.id">
                        <td><TagBadge :tag="t" /></td>
                        <td>
                            <InputText
                                :model-value="t.name"
                                size="small"
                                @change="(e: Event) => save(t, { name: (e.target as HTMLInputElement).value })"
                            />
                        </td>
                        <td>
                            <input
                                type="color"
                                :value="t.color ?? '#888888'"
                                @change="(e: Event) => save(t, { color: (e.target as HTMLInputElement).value })"
                            />
                        </td>
                        <td>
                            <InputText
                                :model-value="t.note ?? ''"
                                size="small"
                                placeholder="(optional)"
                                @change="(e: Event) => save(t, { note: (e.target as HTMLInputElement).value || null })"
                            />
                        </td>
                        <td>
                            <InputText
                                :model-value="String(t.position)"
                                size="small"
                                style="width: 4rem"
                                @change="(e: Event) => {
                                    const n = Number((e.target as HTMLInputElement).value);
                                    if (Number.isFinite(n)) save(t, { position: n });
                                }"
                            />
                        </td>
                        <td>
                            <Button
                                icon="pi pi-trash"
                                severity="danger"
                                text
                                rounded
                                size="small"
                                @click="del(t)"
                            />
                        </td>
                    </tr>
                </tbody>
            </table>
        </section>

        <section class="rules-section">
            <h3>Add a tag</h3>
            <div class="rule-builder">
                <div class="builder-cond">
                    <label class="field-label">name</label>
                    <InputText v-model="newName" placeholder="e.g. blocked" class="w-full" />
                </div>
                <div class="builder-cond">
                    <label class="field-label">color</label>
                    <input
                        type="color"
                        v-model="newColor"
                        style="width: 3rem; height: 2.4rem; cursor: pointer; border: 0; padding: 0; background: transparent"
                    />
                </div>
                <div class="builder-cond" style="flex: 1">
                    <label class="field-label">note (shown on hover)</label>
                    <InputText v-model="newNote" placeholder="(optional)" class="w-full" />
                </div>
                <Button
                    label="add tag"
                    icon="pi pi-plus"
                    @click="add"
                    :disabled="!newName.trim()"
                />
            </div>
        </section>

        <div v-if="error" class="rules-error">
            <i class="pi pi-exclamation-triangle" /> {{ error }}
        </div>
    </div>
</template>

<style>
.tags-page {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
}
.tags-page header h2 {
    margin: 0 0 0.4rem;
}
.tags-table {
    width: 100%;
    border-collapse: collapse;
}
.tags-table th, .tags-table td {
    padding: 0.4rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid var(--p-content-border-color);
    font-size: 0.9rem;
    vertical-align: middle;
}
.tags-table th {
    color: var(--p-text-muted-color);
    font-weight: 500;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}
</style>

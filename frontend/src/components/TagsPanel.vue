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

// #B.250 vcyqn7: reorder via ↑/↓ buttons on each row instead of a
// raw "position" InputText (the numeric column was unusable on
// mobile and unintuitive on desktop). We swap positions with the
// adjacent neighbor and let the WS broadcast refresh the list.
async function move(t: Tag, dir: -1 | 1) {
    const sorted = [...tags.value].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((x) => x.id === t.id);
    if (idx < 0) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    try {
        // Two sequential updates; the order matters only for the WS
        // event log (no constraint conflict on positions).
        await api.updateTag(t.id, { position: other.position });
        await api.updateTag(other.id, { position: t.position });
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}
function canMoveUp(t: Tag): boolean {
    const sorted = [...tags.value].sort((a, b) => a.position - b.position);
    return sorted.length > 1 && sorted[0]?.id !== t.id;
}
function canMoveDown(t: Tag): boolean {
    const sorted = [...tags.value].sort((a, b) => a.position - b.position);
    return sorted.length > 1 && sorted[sorted.length - 1]?.id !== t.id;
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

            <div v-else class="tags-table-wrap">
                <table class="tags-table">
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
                            <td data-label="preview"><TagBadge :tag="t" /></td>
                            <td data-label="name">
                                <InputText
                                    :model-value="t.name"
                                    size="small"
                                    @change="(e: Event) => save(t, { name: (e.target as HTMLInputElement).value })"
                                />
                            </td>
                            <td data-label="color">
                                <input
                                    type="color"
                                    :value="t.color ?? '#888888'"
                                    @change="(e: Event) => save(t, { color: (e.target as HTMLInputElement).value })"
                                />
                            </td>
                            <td data-label="note">
                                <InputText
                                    :model-value="t.note ?? ''"
                                    size="small"
                                    placeholder="(optional)"
                                    @change="(e: Event) => save(t, { note: (e.target as HTMLInputElement).value || null })"
                                />
                            </td>
                            <td data-label="order">
                                <div class="tags-order-controls">
                                    <Button
                                        icon="pi pi-arrow-up"
                                        severity="secondary"
                                        text
                                        rounded
                                        size="small"
                                        :disabled="!canMoveUp(t)"
                                        :title="`Move '${t.name}' up`"
                                        @click="move(t, -1)"
                                    />
                                    <Button
                                        icon="pi pi-arrow-down"
                                        severity="secondary"
                                        text
                                        rounded
                                        size="small"
                                        :disabled="!canMoveDown(t)"
                                        :title="`Move '${t.name}' down`"
                                        @click="move(t, 1)"
                                    />
                                </div>
                            </td>
                            <td data-label="">
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
            </div>
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
.tags-table-wrap {
    width: 100%;
}
.tags-order-controls {
    display: inline-flex;
    gap: 0.1rem;
    align-items: center;
}

/* #B.250 2meddd: narrow viewports — compact 2-line card per tag.
   Layout:
       [↑]   [badge]  [name]   [🎨 color]
       [↓]   [note ........... ............] [🗑]
   Arrows stack vertically on the LEFT, spanning both rows. No
   `order` label — the arrows ARE the affordance. Matches the
   ProjectsPanel compaction pattern (#B.254). */
@media (max-width: 720px) {
    .tags-table thead {
        display: none;
    }
    .tags-table,
    .tags-table tbody {
        display: block;
        width: 100%;
    }
    .tags-table tr {
        display: grid;
        grid-template-columns: auto auto 1fr auto auto;
        grid-template-rows: auto auto;
        column-gap: 0.5rem;
        row-gap: 0.3rem;
        align-items: center;
        border: 1px solid var(--p-content-border-color);
        border-radius: 0.5rem;
        padding: 0.45rem 0.6rem;
        margin-bottom: 0.5rem;
        background: var(--p-surface-50);
        width: 100%;
    }
    .tags-table td {
        padding: 0;
        border: none;
        min-height: 0;
        text-align: left !important;
    }
    .tags-table td::before {
        display: none !important;
    }
    /* Order arrows: col 1, span both rows. Bigger touch target. */
    .tags-table td[data-label="order"] {
        grid-column: 1;
        grid-row: 1 / span 2;
    }
    .tags-order-controls {
        flex-direction: column;
        gap: 0.15rem;
    }
    .tags-order-controls .p-button {
        width: 2.4rem;
        height: 2.4rem;
    }
    .tags-order-controls .p-button .p-button-icon {
        font-size: 1.1rem;
    }
    /* Line 1 — badge, name, color picker (the essentials). */
    .tags-table td[data-label="preview"] {
        grid-column: 2;
        grid-row: 1;
    }
    .tags-table td[data-label="name"] {
        grid-column: 3;
        grid-row: 1;
        min-width: 0;
    }
    .tags-table td[data-label="name"] .p-inputtext {
        width: 100%;
        min-width: 0;
    }
    .tags-table td[data-label="color"] {
        grid-column: 4;
        grid-row: 1;
    }
    /* Line 2 — optional note (stretches) + delete on the right. */
    .tags-table td[data-label="note"] {
        grid-column: 2 / span 3;
        grid-row: 2;
        min-width: 0;
    }
    .tags-table td[data-label="note"] .p-inputtext {
        width: 100%;
        min-width: 0;
    }
    .tags-table tr > td:last-child {
        grid-column: 5;
        grid-row: 1 / span 2;
        align-self: center;
    }
    /* Add-a-tag block: full-width inputs so the form doesn't
       overflow when the parent gets cramped. */
    .tags-page .rule-builder .builder-cond {
        flex: 1 1 100%;
        min-width: 0;
    }
}
</style>

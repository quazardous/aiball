<script setup lang="ts">
import { onMounted, ref } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import { api, type CatalogTag } from "../lib/api";
import { bus, useBus } from "../lib/bus";
import TagBadge from "./TagBadge.vue";
import DataList from "./ui/DataList.vue";
import PanelHeader from "./ui/PanelHeader.vue";

const tags = ref<CatalogTag[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

// Project scope (#223). `_global` shows config global tags + DB tags; a
// project name folds in that project's config tags too. The picker mirrors
// the sentinel pattern from ProjectSettingsPage (Select can't bind null).
const GLOBAL_SENTINEL = "_global";
const project = ref<string>(GLOBAL_SENTINEL);
const projects = ref<string[]>([]);
const projectOptions = ref<{ label: string; value: string }[]>([]);

const isConfig = (t: CatalogTag) => t.source === "config";

const newName = ref("");
const newColor = ref("#3b82f6");
const newNote = ref("");

async function loadProjects() {
    try {
        projects.value = await api.listProjects();
        projectOptions.value = [
            { label: "All projects (global)", value: GLOBAL_SENTINEL },
            ...projects.value.map((p) => ({ label: p, value: p })),
        ];
    } catch {
        projectOptions.value = [{ label: "All projects (global)", value: GLOBAL_SENTINEL }];
    }
}

async function load() {
    loading.value = true;
    try {
        tags.value = await api.listTagCatalog(project.value);
        error.value = null;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

function onProjectChange(v: string) {
    project.value = v;
    void load();
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

// Name + note are config-owned for config tags (read-only); only DB tags
// can edit them. Color + order are editable for BOTH (#223 zcjqgp).
async function save(t: CatalogTag, fields: Partial<CatalogTag>) {
    if (isConfig(t) || t.id == null) return;
    try {
        await api.updateTag(t.id, fields);
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

// Color edit routes by source: config tags persist a name-keyed override
// (DB row, color wins over the config default); DB tags patch by id.
async function saveColor(t: CatalogTag, color: string) {
    try {
        if (isConfig(t)) await api.overrideTag({ name: t.name, color });
        else if (t.id != null) await api.updateTag(t.id, { color });
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

async function del(t: CatalogTag) {
    if (isConfig(t) || t.id == null) return; // config tags are non-deletable
    if (!confirm(`Delete tag '${t.name}'? Any message currently tagged loses it.`))
        return;
    try {
        await api.delTag(t.id);
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}

// #B.250 vcyqn7: reorder via ↑/↓ buttons. Swap positions with the adjacent
// neighbor and let the WS broadcast refresh. Works across BOTH sources
// (#223 zcjqgp): config tags persist the new position as a name-keyed
// override, DB tags patch by id.
function allSorted(): CatalogTag[] {
    return [...tags.value].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}
async function persistPosition(t: CatalogTag, position: number) {
    if (isConfig(t)) await api.overrideTag({ name: t.name, position });
    else if (t.id != null) await api.updateTag(t.id, { position });
}
async function move(t: CatalogTag, dir: -1 | 1) {
    const sorted = allSorted();
    const idx = sorted.findIndex((x) => x === t);
    if (idx < 0) return;
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;
    const other = sorted[swapIdx];
    try {
        await persistPosition(t, other.position);
        await persistPosition(other, t.position);
        bus.emit("tags.refresh");
    } catch (e) {
        error.value = (e as Error).message;
    }
}
function canMoveUp(t: CatalogTag): boolean {
    const sorted = allSorted();
    return sorted.length > 1 && sorted[0] !== t;
}
function canMoveDown(t: CatalogTag): boolean {
    const sorted = allSorted();
    return sorted.length > 1 && sorted[sorted.length - 1] !== t;
}

// Self-refresh on bus events (WS-driven or local mutations).
useBus("tags.refresh", () => load());
onMounted(() => {
    void loadProjects();
    void load();
});
</script>

<template>
    <div class="tags-page">
        <PanelHeader title="Tags">
            <p class="aiball-explainer">
                Tags are a <strong>closed list</strong>: you (the human moderator) define what
                tags exist. Agents can only apply existing tags — they can't invent new ones.
                Use them to group tickets (bug / feature / urgent / done) and as a hook for
                automation rules later on. Tags marked
                <i class="pi pi-lock" style="font-size: 0.75em" /> come from the config files
                (<code>.aiball.yaml</code> → <code>tags:</code>): their name is fixed and they
                can't be deleted, but you can still recolor and reorder them here — an
                overridden color shows a <span class="tags-override-dot">●</span> marker.
            </p>
        </PanelHeader>

        <section class="rules-section">
            <div class="rules-section-head">
                <h3>Catalog ({{ tags.length }})</h3>
                <div class="tags-project-picker">
                    <label class="field-label">project</label>
                    <Select
                        :model-value="project"
                        :options="projectOptions"
                        option-label="label"
                        option-value="value"
                        @update:model-value="onProjectChange"
                    />
                </div>
            </div>

            <DataList table-class="tags-table" :is-empty="!tags.length">
                <template #empty>
                    <div class="aiball-empty">No tags defined yet.</div>
                </template>
                <template #head>
                    <th>Preview</th>
                    <th>Name</th>
                    <th>Color</th>
                    <th>Note</th>
                    <th>Order</th>
                    <th></th>
                </template>
                <template #body>
                        <tr v-for="t in tags" :key="t.id ?? `config:${t.name}`">
                            <td data-label="preview">
                                <span class="tags-preview-cell">
                                    <TagBadge :tag="t" />
                                    <i
                                        v-if="isConfig(t)"
                                        class="pi pi-lock tags-lock"
                                        title="Defined in config — read-only here"
                                    />
                                </span>
                            </td>
                            <td data-label="name">
                                <InputText
                                    :model-value="t.name"
                                    size="small"
                                    :disabled="isConfig(t)"
                                    @change="(e: Event) => save(t, { name: (e.target as HTMLInputElement).value })"
                                />
                            </td>
                            <td data-label="color">
                                <span class="tags-color-cell">
                                    <input
                                        type="color"
                                        :value="t.color ?? '#888888'"
                                        @change="(e: Event) => saveColor(t, (e.target as HTMLInputElement).value)"
                                    />
                                    <span
                                        v-if="t.color_overridden"
                                        class="tags-override-dot"
                                        :title="`Color overridden — config default ${t.config_color ?? '(none)'}`"
                                    >●</span>
                                </span>
                            </td>
                            <td data-label="note">
                                <InputText
                                    :model-value="t.note ?? ''"
                                    size="small"
                                    placeholder="(optional)"
                                    :disabled="isConfig(t)"
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
                                    :disabled="isConfig(t)"
                                    :title="isConfig(t) ? 'Config tag — remove it from the yaml' : `Delete '${t.name}'`"
                                    @click="del(t)"
                                />
                            </td>
                        </tr>
                </template>
            </DataList>
        </section>

        <section class="rules-section">
            <h3>Add a tag</h3>
            <p class="aiball-explainer" style="margin-top: 0">
                New tags are added to the global DB catalog (visible in every project).
                Project-scoped or non-deletable tags live in the config files — see
                <code>.aiball.yaml.example</code>.
            </p>
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
/* Look de base (width/border/padding/th) → `.aiball-table` (style.css).
   Delta : cellules à inputs centrées verticalement (la base est valign top).
   Compound `.aiball-table.tags-table` pour gagner sur la base de façon
   déterministe quel que soit l'ordre de chargement du CSS. */
.aiball-table.tags-table th,
.aiball-table.tags-table td {
    vertical-align: middle;
}
.tags-project-picker {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
}
.tags-project-picker .field-label {
    margin: 0;
}
.tags-preview-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
}
.tags-lock {
    color: var(--p-text-muted-color);
    font-size: 0.75rem;
}
.tags-color-cell {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
}
.tags-override-dot {
    color: var(--p-primary-color);
    font-size: 0.7rem;
    line-height: 1;
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

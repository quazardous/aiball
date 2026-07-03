<script setup lang="ts" generic="T">
/**
 * #453 + #592 — shared admin table shell.
 *
 * Two modes :
 *
 * 1. **Columns-mode (declarative, #592)** — pass `columns` + `rows`. The
 *    component renders the headers (with sort affordance for sortable
 *    columns) AND the rows, dispatching to `#cell-<key>` scoped slots for
 *    each cell so panels keep cell-specific markup (tags, links, …) without
 *    re-implementing sort state / header click handling. Toggle is internal :
 *    click a header to sort asc → desc → asc. Sort values come from
 *    `getSortValue(row, key)` ; the panel owns the computation (e.g. derived
 *    fields like `token_usage → estTokenEffort`).
 *
 * 2. **Slots-mode (legacy)** — pass `#head` + `#body` ; the panel renders
 *    the whole thead/tbody. Kept for panels with non-tabular layouts
 *    (TagsPanel etc.) that don't want the columns-mode rigidity.
 *
 * Either way : carries the `aiball-table` look, the loading/error/empty
 * states, and an optional `#empty` override for the no-data illustration.
 */
import { computed, ref, watch } from "vue";

export interface DataListColumn {
    /** Sort key + dispatch key for `#cell-<key>` slot. Unique per table. */
    key: string;
    /** Header label. */
    label: string;
    /** Click-to-sort affordance. Default false. */
    sortable?: boolean;
    /** Default sort direction when this column is selected for the FIRST time
     *  (subsequent clicks on the same column toggle). Default `"asc"` for
     *  string columns, but numeric/date columns usually want `"desc"`. */
    defaultDir?: "asc" | "desc";
    /** Optional extra class on the `<th>` AND its matching `<td>`. */
    cellClass?: string;
    /** Optional column-level header class (in addition to `cellClass`). */
    headerClass?: string;
}

const props = defineProps<{
    loading?: boolean;
    error?: string | null;
    isEmpty?: boolean;
    tableClass?: string;
    // #592 — columns-mode props (all optional ; presence of `columns` enables
    // the new declarative rendering).
    columns?: readonly DataListColumn[];
    rows?: readonly T[];
    /** Per-row Vue key. Default index — set this for any list that
     *  re-orders (sort) or removes (delete) rows so Vue keeps DOM identity. */
    rowKey?: (row: T, index: number) => string | number;
    /** Custom sort-value extractor. Returns a string/number compared with
     *  `<` / `>`. Default = `row[col.key]`. The panel owns this so derived
     *  values (e.g. `estTokenEffort(token_usage)`) stay in domain code. */
    getSortValue?: (row: T, key: string) => string | number;
    /** Optional per-row class. Passed straight to Vue's `:class` binding —
     *  accepts string, string[], object, or any mix. */
    rowClass?: (row: T) => unknown;
    /** Optional per-row HTML title (tooltip). */
    rowTitle?: (row: T) => string | undefined;
    /** Initial sort key (must match one of `columns[*].key`). */
    defaultSortKey?: string;
    /** Initial sort direction. Defaults to the column's `defaultDir`. */
    defaultSortDir?: "asc" | "desc";
}>();

const emit = defineEmits<{
    (e: "row-click", row: T): void;
}>();

const sortKey = ref<string | null>(props.defaultSortKey ?? null);
const sortDir = ref<"asc" | "desc">(props.defaultSortDir ?? "asc");

// Keep sort state in sync when the parent flips `defaultSortKey` (rare —
// most panels set it once at mount). Avoids stale sort on re-mount.
watch(
    () => props.defaultSortKey,
    (k) => { if (k && !sortKey.value) sortKey.value = k; },
);

function colByKey(key: string): DataListColumn | undefined {
    return props.columns?.find((c) => c.key === key);
}

function toggleSort(col: DataListColumn): void {
    if (!col.sortable) return;
    if (sortKey.value === col.key) {
        sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
    } else {
        sortKey.value = col.key;
        sortDir.value = col.defaultDir ?? "asc";
    }
}

function sortIcon(col: DataListColumn): string {
    if (!col.sortable) return "";
    if (sortKey.value !== col.key) return "pi pi-sort";
    return sortDir.value === "asc" ? "pi pi-sort-up" : "pi pi-sort-down";
}

function sortValueFor(row: T, key: string): string | number {
    if (props.getSortValue) return props.getSortValue(row, key);
    const v = (row as unknown as Record<string, unknown>)[key];
    if (typeof v === "number" || typeof v === "string") return v;
    return String(v ?? "");
}

const sortedRows = computed<readonly T[]>(() => {
    if (!props.rows) return [];
    const key = sortKey.value;
    if (!key) return props.rows;
    const col = colByKey(key);
    if (!col?.sortable) return props.rows;
    const mul = sortDir.value === "asc" ? 1 : -1;
    return [...props.rows].sort((a, b) => {
        const av = sortValueFor(a, key);
        const bv = sortValueFor(b, key);
        if (av < bv) return -1 * mul;
        if (av > bv) return 1 * mul;
        return 0;
    });
});

const useColumnsMode = computed(() => Array.isArray(props.columns));

// #610 david — sortable columns surfaced as a mobile-only `<select>`
// above the table (thead is hidden on mobile because the table reflows
// to a card layout, so the user has no other handle to pick a sort
// axis). Pattern shared across panels via DataList.
const sortableColumns = computed<readonly DataListColumn[]>(() =>
    (props.columns ?? []).filter((c) => c.sortable),
);

function onMobileSortKeyChange(e: Event): void {
    const v = (e.target as HTMLSelectElement).value;
    if (!v) return;
    sortKey.value = v;
    const col = colByKey(v);
    if (col?.defaultDir) sortDir.value = col.defaultDir;
}

function toggleMobileSortDir(): void {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
}
</script>

<template>
    <div class="aiball-table-wrap">
        <div v-if="loading" class="aiball-empty">
            <slot name="loading">Loading…</slot>
        </div>
        <div v-else-if="error" class="aiball-empty aiball-empty--error">{{ error }}</div>
        <slot v-else-if="isEmpty" name="empty">
            <div class="aiball-empty">Nothing here.</div>
        </slot>
        <template v-else>
            <!-- #610 david — mobile sort chooser : visible UNIQUEMENT
                 sur petits viewports via CSS, où thead est caché et le
                 user n'a sinon aucun moyen de choisir un axe de tri.
                 N'affiche que les colonnes `sortable: true`. -->
            <div
                v-if="useColumnsMode && sortableColumns.length > 0"
                class="datalist-mobile-sort"
            >
                <label class="datalist-mobile-sort__label">Sort by</label>
                <select
                    class="datalist-mobile-sort__select"
                    :value="sortKey ?? ''"
                    @change="onMobileSortKeyChange"
                >
                    <option v-if="!sortKey" value="">—</option>
                    <option
                        v-for="col in sortableColumns"
                        :key="col.key"
                        :value="col.key"
                    >{{ col.label }}</option>
                </select>
                <button
                    type="button"
                    class="datalist-mobile-sort__dir"
                    :disabled="!sortKey"
                    :title="sortDir === 'asc' ? 'Ascending — click to reverse' : 'Descending — click to reverse'"
                    @click="toggleMobileSortDir"
                >{{ sortDir === "asc" ? "↑" : "↓" }}</button>
            </div>
            <table class="aiball-table" :class="tableClass">
            <thead>
                <tr>
                    <!-- #592 columns-mode : declarative headers + sort affordance -->
                    <template v-if="useColumnsMode">
                        <th
                            v-for="col in columns"
                            :key="col.key"
                            :class="[col.cellClass, col.headerClass, { sortable: col.sortable }]"
                            @click="toggleSort(col)"
                        >
                            {{ col.label }}<i v-if="col.sortable" :class="['datalist-sort-icon', sortIcon(col)]" />
                        </th>
                    </template>
                    <!-- legacy slot-mode : the panel renders the whole row -->
                    <slot v-else name="head" />
                </tr>
            </thead>
            <tbody>
                <template v-if="useColumnsMode">
                    <tr
                        v-for="(row, idx) in sortedRows"
                        :key="rowKey ? rowKey(row, idx) : idx"
                        :class="(rowClass ? rowClass(row) : undefined) as any"
                        :title="rowTitle ? rowTitle(row) : undefined"
                        @click="emit('row-click', row)"
                    >
                        <td
                            v-for="col in columns"
                            :key="col.key"
                            :class="col.cellClass"
                            :data-label="col.label"
                        >
                            <slot :name="`cell-${col.key}`" :row="row" :value="sortValueFor(row, col.key)" />
                        </td>
                    </tr>
                </template>
                <slot v-else name="body" />
            </tbody>
            </table>
        </template>
    </div>
</template>

<style>
/* #592 — shared sort affordance for columns-mode headers. Slot-mode panels
   keep their own .sortable class (scoped per panel) for back-compat. */
.aiball-table th.sortable {
    cursor: pointer;
    user-select: none;
}
.aiball-table th.sortable:hover {
    color: var(--p-primary-color);
}
.aiball-table th .datalist-sort-icon {
    font-size: 0.75em;
    margin-left: 0.3rem;
    opacity: 0.55;
}

/* #592 nm8myh — shared affordances. Improving any of these in DataList
   propagates to every panel that uses the columns-mode (no per-panel
   re-implementation). */

/* Row-click affordance : the columns-mode renderer always wires
   `@click="emit('row-click', row)"` even when the parent doesn't bind
   the event. PrimeVue's CSS doesn't paint a cursor on table rows, so
   the row-click is invisible without help. The `.dl-clickable` class
   below gets added by panels that DO bind row-click via `rowClass` or
   directly. Kept opt-in so non-interactive lists (TagsPanel inline-edit
   cells, NodesPanel detail views) don't pick up a misleading cursor. */
.aiball-table tr.dl-clickable {
    cursor: pointer;
}
.aiball-table tr.dl-clickable:hover {
    background: var(--p-surface-50);
}

/* Indicator cell — last column used by ProjectsPanel + ConsumersPanel
   for the "live loop" green dot. Shared dimensions + dot styling so the
   pattern doesn't drift between panels. Apply by setting
   `cellClass: "indicator-cell"` on the column, then render the dot in
   the slot with `<span class="indicator-cell__dot" />`. */
.aiball-table .indicator-cell {
    text-align: right;
    width: 2rem;
    min-width: 0;
    padding-right: 0.75rem;
    vertical-align: middle;
}
.aiball-table .indicator-cell__dot {
    display: inline-block;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--p-green-500);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--p-green-500) 25%, transparent);
}

/* Numeric column alignment — apply via `cellClass: "col-num"`. The header
   shouldn't wrap (#597 — `Last activity` was breaking on 2 lines because
   the 6rem hint was tighter than the label); `min-width` lets the column
   expand to fit the longest header / value organically. */
.aiball-table .col-num {
    text-align: right;
    min-width: 6rem;
    white-space: nowrap;
}

/* #610 david — mobile sort chooser. Hidden on desktop (thead clicks
   handle sort there). Visible only on narrow viewports where thead is
   hidden by the panel's mobile pattern. Pattern shipped from DataList
   so every consumer panel (Projects / Consumers / Nodes / Tags) gets it
   uniformly. */
.datalist-mobile-sort {
    display: none;
}
@media (max-width: 720px) {
    .datalist-mobile-sort {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.4rem 0.5rem 0.5rem;
        font-size: var(--fs-md);
    }
    .datalist-mobile-sort__label {
        color: var(--p-text-muted-color);
    }
    .datalist-mobile-sort__select {
        flex: 1 1 auto;
        background: var(--p-content-background);
        color: var(--p-text-color);
        border: 1px solid var(--p-content-border-color);
        border-radius: 0.35rem;
        padding: 0.25rem 0.4rem;
        font: inherit;
    }
    .datalist-mobile-sort__dir {
        background: transparent;
        border: 1px solid var(--p-content-border-color);
        border-radius: 0.35rem;
        padding: 0.1rem 0.6rem;
        cursor: pointer;
        font: inherit;
        color: var(--p-text-color);
    }
    .datalist-mobile-sort__dir:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
    .datalist-mobile-sort__dir:hover:not(:disabled) {
        background: var(--p-surface-100);
    }
}
</style>

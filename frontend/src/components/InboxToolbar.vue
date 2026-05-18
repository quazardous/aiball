<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import ToggleButton from "primevue/togglebutton";
import InputText from "primevue/inputtext";
import { type SortBy, type StatusFilter } from "../lib/labels";

// Toolbar receives the options arrays as props so the parent can swap
// them out if needed; the canonical defaults live in lib/labels.ts.
export interface StatusFilterOption {
    label: string;
    value: StatusFilter;
}

export interface SortOption {
    label: string;
    value: SortBy;
}

export interface ProjectOption {
    label: string;
    value: string | null;
}

defineProps<{
    statusFilter: StatusFilter;
    statusFilterOptions: StatusFilterOption[];
    onlyOpen: boolean;
    sortBy: SortBy;
    sortOptions: SortOption[];
    searchQuery: string;
    /** Project picker — only used on mobile (sidebar is hidden there). */
    projectOptions: ProjectOption[];
    project: string | null;
}>();

const emit = defineEmits<{
    (e: "update:statusFilter", v: StatusFilter): void;
    (e: "update:onlyOpen", v: boolean): void;
    (e: "update:sortBy", v: SortBy): void;
    (e: "update:searchQuery", v: string): void;
    (e: "update:project", v: string | null): void;
    (e: "open-current-settings"): void;
    (e: "new-ticket"): void;
}>();

// #B.161: filters collapse on mobile (<720px). Forced open on
// desktop via CSS — the toggle event re-syncs the ref so the
// :open binding doesn't fight the browser's native click.
const filtersExpanded = ref(typeof window === "undefined" || window.innerWidth > 720);
function syncFilters() {
    filtersExpanded.value = window.innerWidth > 720;
}
function onFiltersToggle(e: Event) {
    filtersExpanded.value = (e.target as HTMLDetailsElement).open;
}
onMounted(() => window.addEventListener("resize", syncFilters));
onUnmounted(() => window.removeEventListener("resize", syncFilters));
</script>

<template>
    <div class="filters-bar">
        <!-- #B.161 mobile: project picker lives in the toolbar now
             (sidebar is hidden on phones), with the settings cog
             beside it. Desktop hides these (sidebar exposes them). -->
        <Select
            class="filter-project filter-mobile-only"
            :model-value="project"
            :options="projectOptions"
            option-label="label"
            option-value="value"
            size="small"
            title="Switch project"
            @update:model-value="(v: string | null) => emit('update:project', v)"
        />
        <button
            v-if="project"
            type="button"
            class="filter-project-settings filter-mobile-only"
            title="Project settings"
            @click="emit('open-current-settings')"
        >
            <i class="pi pi-cog" />
        </button>
        <!-- The less-frequently-used filters (status, only-open,
             sort) collapse inside a <details> panel on mobile.
             Desktop CSS forces the details open so the bar reads
             flat as before. -->
        <details class="filters-collapse" :open="filtersExpanded" @toggle="onFiltersToggle">
            <summary class="filters-collapse__summary" title="Filters">
                <i class="pi pi-filter" /> <span class="filters-collapse__label">filters</span>
            </summary>
            <div class="filters-collapse__body">
                <Select
                    :model-value="statusFilter"
                    :options="statusFilterOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="filter-select"
                    @update:model-value="(v: StatusFilter) => emit('update:statusFilter', v)"
                />
                <ToggleButton
                    :model-value="onlyOpen"
                    on-label="open only"
                    off-label="all"
                    on-icon="pi pi-folder-open"
                    off-icon="pi pi-folder"
                    size="small"
                    @update:model-value="(v: boolean) => emit('update:onlyOpen', v)"
                />
                <Select
                    :model-value="sortBy"
                    :options="sortOptions"
                    option-label="label"
                    option-value="value"
                    size="small"
                    class="filter-select"
                    title="Sort order"
                    @update:model-value="(v: SortBy) => emit('update:sortBy', v)"
                />
            </div>
        </details>
        <span class="filter-search-wrap">
            <InputText
                :model-value="searchQuery"
                placeholder="Search…"
                size="small"
                class="filter-search"
                title="Free-text search across ticket titles, bodies and comments (whitespace = AND)"
                @update:model-value="(v: string | undefined) => emit('update:searchQuery', v ?? '')"
            />
            <button
                v-if="searchQuery"
                type="button"
                class="filter-search__clear"
                title="Clear search"
                @click="emit('update:searchQuery', '')"
            >
                <i class="pi pi-times" />
            </button>
        </span>
        <span class="spacer" />
        <Button
            label="New ticket"
            icon="pi pi-plus"
            size="small"
            @click="emit('new-ticket')"
        />
    </div>
</template>

<style>
.filters-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--p-content-border-color);
    margin-bottom: 0.4rem;
}
/* #B.161: project picker + cog inside the toolbar — visible only
   on mobile (desktop has them in the sidebar). */
.filter-mobile-only {
    display: none;
}
.filter-project {
    flex: 0 1 auto;
    min-width: 7rem;
    max-width: 10rem;
}
.filter-project-settings {
    background: transparent;
    border: 0;
    border-radius: 0.3rem;
    width: 1.8rem;
    height: 1.8rem;
    align-items: center;
    justify-content: center;
    color: var(--p-text-muted-color);
    cursor: pointer;
}
.filter-project-settings:hover {
    background: var(--p-surface-100);
}
.aiball-dark .filter-project-settings:hover {
    background: var(--p-surface-800);
}
/* #B.161: filters live inside a <details> that collapses on mobile.
   Desktop forces the details flat (display: contents on the body)
   so the bar reads the same as before. */
.filters-collapse {
    display: contents;
}
.filters-collapse__summary {
    display: none;
    cursor: pointer;
    list-style: none;
    align-items: center;
    gap: 0.3rem;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-surface-0);
    font-size: 0.85rem;
    user-select: none;
}
.filters-collapse__summary::-webkit-details-marker { display: none; }
.aiball-dark .filters-collapse__summary {
    background: var(--p-surface-800);
}
.filters-collapse__body {
    display: contents;
}
@media (max-width: 720px) {
    .filter-mobile-only {
        display: inline-flex;
    }
    .filter-project-settings.filter-mobile-only {
        display: inline-flex;
    }
    .filters-collapse__summary {
        display: inline-flex;
    }
    .filters-collapse:not([open]) .filters-collapse__body {
        display: none;
    }
    .filters-collapse[open] {
        display: flex;
        flex-direction: column;
        flex: 1 1 100%;
        gap: 0.3rem;
    }
    .filters-collapse[open] .filters-collapse__body {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
    }
    /* Compact filters-bar layout on mobile: search wide, new ticket
       icon-only (label hidden), spacer collapses. */
    .filter-search {
        min-width: 0;
        width: 100%;
    }
    .filter-search-wrap {
        flex: 1 1 auto;
    }
}
.filter-select {
    min-width: 9rem;
}
.filter-search {
    min-width: 12rem;
}
.filter-search-wrap {
    position: relative;
    display: inline-flex;
}
.filter-search-wrap .filter-search :deep(input) {
    padding-right: 1.8rem;
}
.filter-search__clear {
    position: absolute;
    right: 0.35rem;
    top: 50%;
    transform: translateY(-50%);
    background: transparent;
    border: none;
    padding: 0.15rem 0.3rem;
    cursor: pointer;
    color: var(--p-text-muted-color);
    line-height: 1;
    border-radius: 0.2rem;
}
.filter-search__clear:hover {
    color: var(--p-text-color);
    background: var(--p-surface-100);
}
.aiball-dark .filter-search__clear:hover {
    background: var(--p-surface-700);
}
.filter-search__clear i {
    font-size: 0.8rem;
}
</style>

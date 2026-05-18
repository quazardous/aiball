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
    /** Optional counts so the dropdown surfaces the same badges
        as the sidebar did (#B.161 follow-up). */
    pending?: number;
    unread?: number;
    open?: number;
    resolved?: number;
}

import { computed } from "vue";
const props = defineProps<{
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

// #B.161 follow-up: project picker dropdown open state + helpers
// to render the current project's badges inline in the summary.
const projectOpen = ref(false);
const activeProjectLabel = computed(
    () => props.projectOptions.find((p) => p.value === props.project)?.label ?? "All projects",
);
const activeProjectBadges = computed(() => {
    const p = props.projectOptions.find((o) => o.value === props.project);
    if (!p) return [];
    const out: { kind: string; count: number }[] = [];
    if (p.pending && p.pending > 0) out.push({ kind: "pending", count: p.pending });
    if (p.resolved && p.resolved > 0) out.push({ kind: "resolved", count: p.resolved });
    if (p.unread && p.unread > 0) out.push({ kind: "unread", count: p.unread });
    if (p.open && p.open > 0) out.push({ kind: "open", count: p.open });
    return out;
});
function pickProject(v: string | null) {
    emit("update:project", v);
    projectOpen.value = false;
}

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
        <!-- #B.161 mobile: project picker = native CSS dropdown
             with badges per project (david: "remet les compteurs"
             + "drop down etc de manière plus css"). Sidebar hidden,
             this carries the navigation + the visual counts. -->
        <details
            class="filter-project-dropdown filter-mobile-only"
            :open="projectOpen"
            @toggle="(e: Event) => projectOpen = (e.target as HTMLDetailsElement).open"
        >
            <summary class="filter-project-dropdown__summary" :title="`Current project: ${activeProjectLabel}`">
                <span class="filter-project-dropdown__label">{{ activeProjectLabel }}</span>
                <span v-if="activeProjectBadges.length" class="filter-project-dropdown__badges">
                    <span
                        v-for="b in activeProjectBadges"
                        :key="b.kind"
                        class="filter-project-dropdown__badge"
                        :class="`filter-project-dropdown__badge--${b.kind}`"
                    >{{ b.count }}</span>
                </span>
                <i class="pi pi-chevron-down filter-project-dropdown__chev" />
            </summary>
            <div class="filter-project-dropdown__menu">
                <button
                    v-for="p in projectOptions"
                    :key="p.value ?? '__all__'"
                    type="button"
                    class="filter-project-dropdown__item"
                    :class="{ 'filter-project-dropdown__item--current': p.value === project }"
                    @click="pickProject(p.value)"
                >
                    <span class="filter-project-dropdown__item-label">{{ p.label }}</span>
                    <span class="filter-project-dropdown__badges">
                        <span v-if="p.pending && p.pending > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--pending">{{ p.pending }}</span>
                        <span v-if="p.resolved && p.resolved > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--resolved">{{ p.resolved }}</span>
                        <span v-if="p.unread && p.unread > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--unread">{{ p.unread }}</span>
                        <span v-if="p.open && p.open > 0" class="filter-project-dropdown__badge filter-project-dropdown__badge--open">{{ p.open }}</span>
                    </span>
                </button>
            </div>
        </details>
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
.filter-project-dropdown {
    position: relative;
    flex: 0 1 auto;
}
.filter-project-dropdown > summary {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    list-style: none;
    padding: 0.3rem 0.55rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-surface-0);
    font-size: 0.85rem;
    max-width: 12rem;
}
.filter-project-dropdown > summary::-webkit-details-marker { display: none; }
.aiball-dark .filter-project-dropdown > summary {
    background: var(--p-surface-800);
}
.filter-project-dropdown__label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.filter-project-dropdown__chev {
    font-size: 0.65rem;
    color: var(--p-text-muted-color);
    transition: transform 0.15s;
}
.filter-project-dropdown[open] .filter-project-dropdown__chev {
    transform: rotate(180deg);
}
.filter-project-dropdown__menu {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    min-width: 16rem;
    max-width: calc(100vw - 2rem);
    background: var(--p-content-background);
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    box-shadow: 0 6px 16px rgba(0,0,0,0.12);
    z-index: 20;
    padding: 0.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    max-height: 70vh;
    overflow-y: auto;
}
.filter-project-dropdown__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    background: transparent;
    border: 0;
    border-radius: 0.3rem;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.9rem;
    color: var(--p-text-color);
}
.filter-project-dropdown__item:hover {
    background: var(--p-surface-100);
}
.aiball-dark .filter-project-dropdown__item:hover {
    background: var(--p-surface-800);
}
.filter-project-dropdown__item--current {
    color: var(--p-primary-color);
    font-weight: 600;
}
.filter-project-dropdown__item-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.filter-project-dropdown__badges {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
}
.filter-project-dropdown__badge {
    font-size: 0.7rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.1rem 0.4rem;
    line-height: 1;
}
.filter-project-dropdown__badge--pending { background: var(--p-yellow-500); color: black; }
.filter-project-dropdown__badge--unread  { background: var(--p-blue-500); color: white; }
.filter-project-dropdown__badge--resolved{ background: var(--p-green-500); color: white; }
.filter-project-dropdown__badge--open    { background: var(--p-surface-200); color: var(--p-text-color); }
.aiball-dark .filter-project-dropdown__badge--open { background: var(--p-surface-700); }
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
    gap: 0.25rem;
    /* #B.161 follow-up: filter toggle is a secondary action, not a
       primary button (david: "le bouton qui toggle les filtre a
       trop d'imortance pour ce qu'il fait"). Text-only with muted
       color, no border. */
    padding: 0.2rem 0.4rem;
    border: 0;
    background: transparent;
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
    user-select: none;
}
.filters-collapse__summary:hover {
    color: var(--p-text-color);
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
    .filters-collapse {
        display: contents;
    }
    /* When unfolded, the body becomes a sibling row (flex-basis 100%
       forces line break) — the summary itself stays inline alongside
       project picker + search. David: "pourquoi filter va a la ligne
       en version unfold ?? et plein de place vide". */
    .filters-collapse[open] .filters-collapse__body {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        flex: 1 0 100%;
        padding: 0.3rem 0;
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

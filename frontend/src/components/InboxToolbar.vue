<script setup lang="ts">
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

defineProps<{
    statusFilter: StatusFilter;
    statusFilterOptions: StatusFilterOption[];
    onlyOpen: boolean;
    sortBy: SortBy;
    sortOptions: SortOption[];
    searchQuery: string;
}>();

const emit = defineEmits<{
    (e: "update:statusFilter", v: StatusFilter): void;
    (e: "update:onlyOpen", v: boolean): void;
    (e: "update:sortBy", v: SortBy): void;
    (e: "update:searchQuery", v: string): void;
    (e: "new-ticket"): void;
}>();
</script>

<template>
    <div class="filters-bar">
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
        <InputText
            :model-value="searchQuery"
            placeholder="Search…"
            size="small"
            class="filter-search"
            title="Free-text search across ticket titles, bodies and comments (whitespace = AND)"
            @update:model-value="(v: string | undefined) => emit('update:searchQuery', v ?? '')"
        />
        <span class="spacer" />
        <Button
            label="New ticket"
            icon="pi pi-plus"
            size="small"
            @click="emit('new-ticket')"
        />
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";

const props = defineProps<{
    page: number;
    pageSize: number;
    total: number;
}>();

const emit = defineEmits<{
    (e: "update:page", v: number): void;
    (e: "update:pageSize", v: number): void;
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const start = computed(() =>
    props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1,
);
const end = computed(() => Math.min(props.total, props.page * props.pageSize));

const pageSizeOptions = [10, 25, 50, 100];

function goto(p: number) {
    const next = Math.max(1, Math.min(totalPages.value, p));
    if (next !== props.page) emit("update:page", next);
}
</script>

<template>
    <div class="pagination-bar">
        <Button
            icon="pi pi-angle-left"
            severity="secondary"
            text
            size="small"
            :disabled="page <= 1"
            @click="goto(page - 1)"
        />
        <span class="pagination-bar__indicator">
            <strong>{{ start }}</strong>–<strong>{{ end }}</strong>
            of <strong>{{ total }}</strong>
            <span v-if="totalPages > 1" class="pagination-bar__page">
                · page {{ page }} / {{ totalPages }}
            </span>
        </span>
        <Button
            icon="pi pi-angle-right"
            severity="secondary"
            text
            size="small"
            :disabled="page >= totalPages"
            @click="goto(page + 1)"
        />
        <span class="spacer" />
        <Select
            :model-value="pageSize"
            :options="pageSizeOptions"
            size="small"
            class="pagination-bar__size"
            title="Rows per page"
            @update:model-value="(v: number) => emit('update:pageSize', v)"
        />
        <span class="pagination-bar__size-label">/ page</span>
    </div>
</template>

<style scoped>
.pagination-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.6rem;
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    border-top: 1px solid var(--p-content-border-color);
    border-bottom: 1px solid var(--p-content-border-color);
    margin-top: 0.4rem;
}
.pagination-bar__indicator {
    font-variant-numeric: tabular-nums;
}
.pagination-bar__indicator strong {
    color: var(--p-text-color);
    font-weight: 600;
}
.pagination-bar__page {
    margin-left: 0.4rem;
    opacity: 0.8;
}
.pagination-bar__size {
    /* Wide enough to fit "100" without truncating once the PrimeVue
     * Select adds its padding + chevron-icon (~42px combined). */
    width: 5.5rem;
}
.pagination-bar__size-label {
    font-size: 0.78rem;
    opacity: 0.75;
}
</style>

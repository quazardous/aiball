<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import DataList, { type DataListColumn } from "@kit/DataList.vue";
import SectionHeader from "@kit/SectionHeader.vue";
import { listParts, type Part } from "./store";

// Step 5 — "list children": a child table living inside the parent's detail
// page. This is where the kit holds up best: DataList nests with no ceremony,
// SectionHeader gives the heading. Both stayed additive.
const props = defineProps<{ widgetId: string }>();
const emit = defineEmits<{ (e: "open", partId: string): void }>();

const rows = ref<Part[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const columns: DataListColumn[] = [
    { key: "name", label: "Part", sortable: true },
    { key: "qty", label: "Qty", sortable: true, defaultDir: "desc" },
];

async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
        rows.value = await listParts(props.widgetId);
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
}

onMounted(load);
watch(() => props.widgetId, load);
</script>

<template>
    <SectionHeader title="Parts">
        Step 5 — a child list nested in the parent's detail page.
    </SectionHeader>

    <DataList
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        :is-empty="rows.length === 0"
        :row-key="(p: Part) => p.id"
        default-sort-key="name"
        @row-click="(p: Part) => emit('open', p.id)"
    >
        <template #empty>This widget has no parts.</template>
    </DataList>
</template>

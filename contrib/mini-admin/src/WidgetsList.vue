<script setup lang="ts">
import { onMounted, ref } from "vue";
import DataList, { type DataListColumn } from "@kit/DataList.vue";
import PanelHeader from "@kit/PanelHeader.vue";
import StatusPill from "@kit/StatusPill.vue";
import { listWidgets, type Widget, type WidgetStatus } from "./store";

const emit = defineEmits<{ (e: "open", id: string): void }>();

function pillStatus(s: WidgetStatus): "up" | "stale" | "down" {
    return s === "active" ? "up" : s === "draft" ? "stale" : "down";
}

const rows = ref<Widget[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const columns: DataListColumn[] = [
    { key: "name", label: "Name", sortable: true },
    { key: "status", label: "Status", sortable: true },
    { key: "owner", label: "Owner", sortable: true },
    { key: "updatedAt", label: "Updated", sortable: true, defaultDir: "desc" },
];

onMounted(async () => {
    try {
        rows.value = await listWidgets();
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e);
    } finally {
        loading.value = false;
    }
});
</script>

<template>
    <PanelHeader title="Widgets">
        <p class="aiball-explainer aiball-explainer--muted">
            Step 2 — list + detail on a fake store. Click a row to open it.
        </p>
    </PanelHeader>

    <DataList
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :error="error"
        :is-empty="rows.length === 0"
        :row-key="(w: Widget) => w.id"
        default-sort-key="name"
        @row-click="(w: Widget) => emit('open', w.id)"
    >
        <template #cell-status="{ row }">
            <!-- StatusPill calls itself domain-agnostic, but its three statuses
                 are liveness words (up/stale/down). A widget is not "up", so the
                 demo has to translate its own vocabulary into someone else's. -->
            <StatusPill
                :status="pillStatus((row as Widget).status)"
                :label="(row as Widget).status"
            />
        </template>
        <template #empty>No widgets yet.</template>
    </DataList>
</template>

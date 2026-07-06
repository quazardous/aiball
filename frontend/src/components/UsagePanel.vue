<script setup lang="ts">
/**
 * #1200 — "Usage" admin panel: token usage over time. Filters (project, metric,
 * range) in one row above a single-series line chart. All-projects sums each
 * timestamp; a project scopes to one. First dataviz — see TokenUsageChart.vue.
 */
import { computed, onMounted, ref, watch } from "vue";
import Select from "primevue/select";
import { api, type TokenSnapshotRow } from "../lib/api";
import { useNotify } from "../lib/notify";
import TokenUsageChart from "./TokenUsageChart.vue";
import PanelHeader from "./ui/PanelHeader.vue";

const notify = useNotify();
const rows = ref<TokenSnapshotRow[]>([]);
const projects = ref<string[]>([]);
const loading = ref(false);

const project = ref<string>("");     // "" = all projects
const metric = ref<"tokens_out" | "tokens_in" | "total" | "cache_r" | "cache_w">("tokens_out");
const days = ref<number>(30);

const metricOptions = [
    { label: "Output tokens", value: "tokens_out" },
    { label: "Input tokens", value: "tokens_in" },
    { label: "Total (in+out)", value: "total" },
    { label: "Cache read", value: "cache_r" },
    { label: "Cache write", value: "cache_w" },
];
const rangeOptions = [
    { label: "7 days", value: 7 },
    { label: "30 days", value: 30 },
    { label: "90 days", value: 90 },
    { label: "All", value: 0 },
];
const projectOptions = computed(() => [
    { label: "All projects", value: "" },
    ...projects.value.map((p) => ({ label: p, value: p })),
]);

function metricVal(r: TokenSnapshotRow): number {
    if (metric.value === "total") return r.tokens_in + r.tokens_out;
    return r[metric.value];
}

// Aggregate rows → chart points. All-projects: sum per captured_at.
const points = computed(() => {
    const byTs = new Map<number, number>();
    for (const r of rows.value) {
        if (project.value && r.project !== project.value) continue;
        const t = Date.parse(r.captured_at);
        byTs.set(t, (byTs.get(t) ?? 0) + metricVal(r));
    }
    return [...byTs.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
});

const metricLabel = computed(() => metricOptions.find((m) => m.value === metric.value)?.label ?? "tokens");
const scopeLabel = computed(() => (project.value ? project.value : "all projects"));

async function load(): Promise<void> {
    loading.value = true;
    try {
        const [ts, projs] = await Promise.all([
            api.tokenTimeseries({ days: days.value || undefined }),
            projects.value.length ? Promise.resolve(projects.value) : api.listProjects(),
        ]);
        rows.value = ts.series;
        if (!projects.value.length) projects.value = projs;
    } catch (e) {
        notify.error("Failed to load token usage", { detail: (e as Error).message });
    } finally {
        loading.value = false;
    }
}
onMounted(load);
watch(days, load);
</script>

<template>
    <div class="usage-panel">
        <PanelHeader icon="pi pi-chart-line" title="Token usage" />
        <div class="usage-filters">
            <Select v-model="project" :options="projectOptions" option-label="label" option-value="value" />
            <Select v-model="metric" :options="metricOptions" option-label="label" option-value="value" />
            <Select v-model="days" :options="rangeOptions" option-label="label" option-value="value" />
        </div>
        <div class="usage-chart-title">
            {{ metricLabel }} over time · {{ scopeLabel }}
        </div>
        <TokenUsageChart :points="points" unit="tokens" />
    </div>
</template>

<style scoped>
.usage-panel { padding: 0.5rem 0.25rem; }
.usage-filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin: 0.75rem 0 0.25rem; }
.usage-chart-title {
    font-size: var(--fs-sm, 0.85rem);
    color: var(--p-text-muted-color);
    margin: 0.5rem 0 0.25rem 0.25rem;
}
</style>

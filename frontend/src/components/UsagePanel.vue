<script setup lang="ts">
/**
 * #1200 — "Usage" admin panel: token usage over time. Two fixed multi-curve
 * charts (#5ndpm8): input+output, and cache read+write — no metric selector.
 * Filters (project, range) scope both. All-projects sums each timestamp; a
 * project scopes to one. See TokenUsageChart.vue for the uPlot render.
 */
import { computed, onMounted, ref, watch } from "vue";
import Select from "primevue/select";
import { api, type TokenSnapshotRow } from "../lib/api";
import { useNotify } from "../lib/notify";
import TokenUsageChart from "./TokenUsageChart.vue";
import PanelHeader from "./ui/PanelHeader.vue";

// #dpa34u — deep-link from a project detail page (`/usage?p=<project>`) scopes
// the panel to that project on open. Absent → all projects.
const props = defineProps<{ initialProject?: string | null }>();

const notify = useNotify();
const rows = ref<TokenSnapshotRow[]>([]);
const projects = ref<string[]>([]);
const loading = ref(false);

const project = ref<string>(props.initialProject || "__all");   // sentinel = all projects (PrimeVue Select drops "" as no-selection)
const days = ref<number>(1);   // #bmzqw8 — default 24h (hourly captures, young series)

const rangeOptions = [
    { label: "24h", value: 1 },
    { label: "7 days", value: 7 },
    { label: "30 days", value: 30 },
    { label: "90 days", value: 90 },
    { label: "All", value: 0 },
];
const projectOptions = computed(() => [
    { label: "All projects", value: "__all" },
    ...projects.value.map((p) => ({ label: p, value: p })),
]);

// Sum one field per timestamp, honouring the project filter (all-projects
// sums across projects; a scoped project keeps only its rows).
function metricPoints(field: (r: TokenSnapshotRow) => number): { t: number; v: number }[] {
    const byTs = new Map<number, number>();
    for (const r of rows.value) {
        if (project.value !== "__all" && r.project !== project.value) continue;
        const t = Date.parse(r.captured_at);
        byTs.set(t, (byTs.get(t) ?? 0) + field(r));
    }
    return [...byTs.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

const ioSeries = computed(() => [
    { label: "input", points: metricPoints((r) => r.tokens_in) },
    { label: "output", points: metricPoints((r) => r.tokens_out) },
]);
const cacheSeries = computed(() => [
    { label: "cache read", points: metricPoints((r) => r.cache_r) },
    { label: "cache write", points: metricPoints((r) => r.cache_w) },
]);

const scopeLabel = computed(() => (project.value === "__all" ? "all projects" : project.value));

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
// Re-scope if the deep-link target changes while mounted (rare — the panel
// normally mounts fresh on navigation, but keep it robust).
watch(() => props.initialProject, (p) => { if (p) project.value = p; });
</script>

<template>
    <div class="usage-panel">
        <PanelHeader icon="pi pi-chart-line" title="Token usage" />
        <div class="usage-filters">
            <Select v-model="project" :options="projectOptions" option-label="label" option-value="value" />
            <Select v-model="days" :options="rangeOptions" option-label="label" option-value="value" />
        </div>

        <div class="usage-chart-title">Input / output · {{ scopeLabel }}</div>
        <TokenUsageChart :series="ioSeries" unit="tokens" />

        <div class="usage-chart-title usage-chart-title--second">Cache read / write · {{ scopeLabel }}</div>
        <TokenUsageChart :series="cacheSeries" unit="tokens" />
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
.usage-chart-title--second { margin-top: 1.5rem; }
</style>

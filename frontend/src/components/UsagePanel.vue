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
const vizMode = ref<"line" | "bars">("bars");   // #1232 — per-interval consumption reads better as bars

const vizOptions = [
    { label: "Bars", value: "bars" },
    { label: "Line", value: "line" },
];
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

// Snapshots store the CUMULATIVE tally; david wants the DERIVATIVE — tokens
// consumed BETWEEN captures. Diff each project's own series (v[i]-v[i-1]),
// clamp negatives (a tally reset shouldn't render as a downward spike), then
// sum per timestamp (all-projects) honouring the project filter.
function metricDelta(field: (r: TokenSnapshotRow) => number): { t: number; v: number }[] {
    const byProject = new Map<string, { t: number; v: number }[]>();
    for (const r of rows.value) {
        if (project.value !== "__all" && r.project !== project.value) continue;
        const arr = byProject.get(r.project) ?? [];
        arr.push({ t: Date.parse(r.captured_at), v: field(r) });
        byProject.set(r.project, arr);
    }
    const byTs = new Map<number, number>();
    for (const arr of byProject.values()) {
        arr.sort((a, b) => a.t - b.t);
        for (let i = 1; i < arr.length; i++)
            byTs.set(arr[i].t, (byTs.get(arr[i].t) ?? 0) + Math.max(0, arr[i].v - arr[i - 1].v));
    }
    return [...byTs.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

const ioSeries = computed(() => [
    { label: "input", points: metricDelta((r) => r.tokens_in) },
    { label: "output", points: metricDelta((r) => r.tokens_out) },
]);
const cacheSeries = computed(() => [
    { label: "cache read", points: metricDelta((r) => r.cache_r) },
    { label: "cache write", points: metricDelta((r) => r.cache_w) },
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
            <Select v-model="vizMode" :options="vizOptions" option-label="label" option-value="value" />
        </div>

        <div class="usage-chart-title">Input / output — consumed per capture (Δ) · {{ scopeLabel }}</div>
        <TokenUsageChart :series="ioSeries" :mode="vizMode" unit="tokens" />

        <div class="usage-chart-title usage-chart-title--second">Cache read / write — consumed per capture (Δ) · {{ scopeLabel }}</div>
        <TokenUsageChart :series="cacheSeries" :mode="vizMode" unit="tokens" />
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

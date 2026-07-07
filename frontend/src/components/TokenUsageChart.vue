<script setup lang="ts">
/**
 * #1200 — single-series token-usage-over-time line chart, on uPlot (#4gqxtp:
 * david « utilise une lib », the hand-rolled SVG anchored Y at 0 so slowly-
 * growing cumulative totals looked flat). uPlot auto-fits the Y domain to the
 * data range → the variation shows. One series by design → the built-in legend
 * names it ; one accent hue. Canvas colors are baked at build time, so we read
 * them from the theme tokens and rebuild on a light/dark toggle.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface Pt { t: number; v: number }
const props = defineProps<{
    points: Pt[];
    /** legend / tooltip unit label, e.g. "tokens". */
    unit?: string;
}>();

const container = ref<HTMLDivElement | null>(null);
let plot: uPlot | null = null;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

const hasData = computed(() => props.points.length > 0);

// Resolve a CSS custom property against the container (so the viewer's theme
// wins), falling back to a sane default when the token is unset.
function cssVar(name: string, fallback: string): string {
    const el = container.value ?? document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

function fmtNum(n: number): string {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
}

// uPlot time scale wants UNIX seconds; our timestamps are ms.
function toData(): uPlot.AlignedData {
    const s = [...props.points].sort((a, b) => a.t - b.t);
    return [s.map((p) => Math.round(p.t / 1000)), s.map((p) => p.v)];
}

function build(): void {
    if (!container.value || !hasData.value) return;
    destroy();
    const data = toData();
    const stroke = cssVar("--p-primary-color", "#3b82f6");
    const axisColor = cssVar("--p-text-muted-color", "#9ca3af");
    const gridColor = cssVar("--p-content-border-color", "#e5e7eb");
    const opts: uPlot.Options = {
        width: container.value.clientWidth || 720,
        height: 260,
        padding: [12, 16, 0, 4],
        cursor: { points: { size: 6 } },
        legend: { show: true },
        scales: { x: { time: true } },
        series: [
            {},
            {
                label: props.unit || "tokens",
                stroke,
                width: 2,
                points: { show: data[0].length < 40 },
                value: (_u, v) => (v == null ? "--" : Number(v).toLocaleString()),
            },
        ],
        axes: [
            {
                stroke: axisColor,
                grid: { stroke: gridColor, width: 1 },
                ticks: { stroke: gridColor, width: 1 },
            },
            {
                stroke: axisColor,
                size: 56,
                grid: { stroke: gridColor, width: 1 },
                ticks: { stroke: gridColor, width: 1 },
                values: (_u, vals) => vals.map((v) => fmtNum(v)),
            },
        ],
    };
    plot = new uPlot(opts, data, container.value);
}

function destroy(): void {
    if (plot) { plot.destroy(); plot = null; }
}

onMounted(() => {
    build();
    // Responsive width : uPlot needs explicit px, so mirror the container.
    ro = new ResizeObserver(() => {
        if (plot && container.value) plot.setSize({ width: container.value.clientWidth || 720, height: 260 });
    });
    if (container.value) ro.observe(container.value);
    // Theme toggle stamps the root (class / data-theme) — canvas colors are
    // baked at build, so rebuild when it flips.
    mo = new MutationObserver(() => build());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
});

// New data : cheap in-place update ; build lazily if the plot didn't exist yet
// (e.g. mounted with an empty series, points arrived after the first fetch).
watch(
    () => props.points,
    () => {
        if (plot) plot.setData(toData());
        else build();
    },
    { deep: true },
);

onBeforeUnmount(() => {
    ro?.disconnect();
    mo?.disconnect();
    destroy();
});
</script>

<template>
    <div class="tuc">
        <div ref="container" class="tuc__plot" />
        <div v-if="!hasData" class="tuc__empty">
            No snapshots yet — the series builds up as the daemon captures token usage over time.
        </div>
    </div>
</template>

<style scoped>
.tuc { position: relative; width: 100%; }
.tuc__plot { width: 100%; min-height: 260px; }
.tuc__empty {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--p-text-muted-color, #9ca3af);
    font-size: var(--fs-sm, 0.85rem);
}
</style>

<style>
/* uPlot legend : lean on the theme ink tokens (its default is a bare table). */
.tuc .u-legend { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--p-text-muted-color); }
.tuc .u-legend .u-value { color: var(--p-text-color); }
</style>

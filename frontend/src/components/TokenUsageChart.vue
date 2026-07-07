<script setup lang="ts">
/**
 * #1200 — token-usage-over-time line chart on uPlot (#4gqxtp: david « utilise
 * une lib » — a hand-rolled SVG anchored Y at 0 so the curves looked flat).
 * Multi-series (#5ndpm8): each chart carries a fixed family of curves
 * (input+output, or cache read+write) with a legend — no metric selector.
 * uPlot auto-fits Y to the data range; canvas colors come from the theme
 * tokens (+ a small fixed palette for the extra series) and rebuild on a
 * light/dark toggle.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

interface Series { label: string; points: { t: number; v: number }[] }
const props = defineProps<{
    series: Series[];
    /** legend / tooltip unit label, e.g. "tokens". */
    unit?: string;
    /** #1232 — render as grouped bars (per-interval consumption reads better as
     *  bars) or the classic line. Default line. */
    mode?: "line" | "bars";
}>();

const container = ref<HTMLDivElement | null>(null);
let plot: uPlot | null = null;
let ro: ResizeObserver | null = null;
let mo: MutationObserver | null = null;

const hasData = computed(() => props.series.some((s) => s.points.length > 0));

function cssVar(name: string, fallback: string): string {
    const el = container.value ?? document.documentElement;
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

// Series palette : first = theme accent (adapts light/dark), rest = fixed hues
// that read on both themes. Two series per chart today, headroom for more.
function palette(): string[] {
    return [cssVar("--p-primary-color", "#3b82f6"), "#f59e0b", "#10b981", "#ef4444"];
}

function fmtNum(n: number): string {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
}

// uPlot wants columnar AlignedData [xs, y1s, y2s, …] over a shared x axis.
// Series share snapshot timestamps, but union+gap-fill (null) stays correct if
// one lags. uPlot time scale wants UNIX seconds; our timestamps are ms.
function toData(): uPlot.AlignedData {
    const tset = new Set<number>();
    for (const s of props.series) for (const p of s.points) tset.add(p.t);
    const ts = [...tset].sort((a, b) => a - b);
    const cols = props.series.map((s) => {
        const m = new Map(s.points.map((p) => [p.t, p.v]));
        return ts.map((t) => (m.has(t) ? (m.get(t) as number) : null));
    });
    return [ts.map((t) => Math.round(t / 1000)), ...cols] as uPlot.AlignedData;
}

function build(): void {
    if (!container.value || !hasData.value) return;
    destroy();
    const data = toData();
    const nPts = data[0].length;
    const colors = palette();
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
            ...props.series.map((s, i) => {
                const color = colors[i % colors.length];
                const base = {
                    label: s.label,
                    stroke: color,
                    width: 2,
                    value: (_u: uPlot, v: number | null) => (v == null ? "--" : Number(v).toLocaleString()),
                };
                // #1232 — bars mode: uPlot's bars() path auto-groups sibling bar
                // series side-by-side within each x slot; fill the bars.
                if (props.mode === "bars") {
                    return {
                        ...base,
                        paths: uPlot.paths!.bars!({ size: [0.9, 60], gap: 2 }),
                        fill: color,
                        points: { show: false },
                    };
                }
                return { ...base, points: { show: nPts < 40 } };
            }),
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
    ro = new ResizeObserver(() => {
        if (plot && container.value) plot.setSize({ width: container.value.clientWidth || 720, height: 260 });
    });
    if (container.value) ro.observe(container.value);
    // Theme toggle stamps the root — canvas colors are baked at build, rebuild.
    mo = new MutationObserver(() => build());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
});

watch(
    () => props.series,
    () => {
        // #b7622z — when a filter change empties the series, TEAR DOWN the plot
        // (else a stale/degenerate canvas lingers under the empty message =
        // "cassé/aberrant"). Rebuild when data returns. Otherwise cheap setData.
        if (!hasData.value) { destroy(); return; }
        if (plot) plot.setData(toData());
        else build();
    },
    { deep: true },
);

// #1232 — switching line ⇄ bars changes the series `paths`, which uPlot bakes
// at construction → full rebuild.
watch(() => props.mode, build);

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

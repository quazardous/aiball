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
    /** #1232 — render as STACKED bars (per-interval consumption reads better as
     *  bars, and the stack's total height is the real per-interval spend) or the
     *  classic overlaid line. Default line. */
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

// The sorted ms timestamps of the CURRENT plot data. Bars mode uses an ordinal
// x-axis (indices), so tick labels + the legend map an index back to its
// timestamp through this (kept fresh on every (re)build / setData).
let curTs: number[] = [];

// Label for an ordinal x value. The bars scale is padded half a slot past each
// end (#p3hm5c), so a split can land off-data or between two indices — those
// get no label rather than a wrong one.
function tsAt(x: number): string {
    const i = Math.round(x);
    if (Math.abs(x - i) > 1e-9 || curTs[i] == null) return "";
    return fmtTs(curTs[i]);
}

// Raw (un-stacked) values of the CURRENT plot data, per series. In bars mode the
// plotted column is the cumulative stack height — the legend must still show what
// the series itself consumed, so it reads back through this (#1247).
let curRaw: (number | null)[][] = [];

function fmtTs(ms: number): string {
    const d = new Date(ms);
    const span = curTs.length ? curTs[curTs.length - 1] - curTs[0] : 0;
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return span < 2 * 86_400_000 ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// #1247 — turn raw columns into STACKED ones. uPlot bars always anchor at the
// scale floor, so a stack is expressed as cumulative heights + paint order: the
// LAST series is the bottom of the stack, series i carries the sum of itself and
// everything below it. Series are then drawn in their natural 0..n-1 order, so
// series 0 (the tallest, full total) paints first and each lower one overpaints
// its base — leaving series 0 visible only as the top segment. david `#1247`:
// "input au dessus de output", i.e. props.series[0] sits on top.
// All-null at a timestamp stays null (a gap, not a zero bar).
function stackCols(cols: (number | null)[][]): (number | null)[][] {
    const n = cols[0]?.length ?? 0;
    const out = cols.map(() => new Array<number | null>(n).fill(null));
    for (let i = 0; i < n; i++) {
        let acc = 0;
        let any = false;
        for (let s = cols.length - 1; s >= 0; s--) {   // bottom → top
            const v = cols[s][i];
            if (v != null) { acc += v; any = true; }
            out[s][i] = any ? acc : null;
        }
    }
    return out;
}

// uPlot wants columnar AlignedData [xs, y1s, y2s, …]. Series share snapshot
// timestamps; union+gap-fill (null) stays correct if one lags.
//   line mode → x = UNIX seconds on a TIME scale (real spacing), curves overlaid
//               on a shared scale (david: "les lignes peuvent partager la même échelle").
//   bars mode → x = 0..n-1 indices on an ORDINAL axis, so bars are uniform &
//               evenly spaced regardless of irregular capture intervals
//               (#jt9jtj: time-scale bars went thin + very spaced on sparse data),
//               and y is STACKED (#1247).
function alignedData(): uPlot.AlignedData {
    const tset = new Set<number>();
    for (const s of props.series) for (const p of s.points) tset.add(p.t);
    const ts = [...tset].sort((a, b) => a - b);
    curTs = ts;
    const cols = props.series.map((s) => {
        const m = new Map(s.points.map((p) => [p.t, p.v]));
        return ts.map((t) => (m.has(t) ? (m.get(t) as number) : null));
    });
    curRaw = cols;
    const bars = props.mode === "bars";
    const xs = bars ? ts.map((_, i) => i) : ts.map((t) => Math.round(t / 1000));
    return [xs, ...(bars ? stackCols(cols) : cols)] as uPlot.AlignedData;
}

function build(): void {
    if (!container.value || !hasData.value) return;
    destroy();
    const bars = props.mode === "bars";
    const data = alignedData();
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
        // bars → ordinal x (evenly-spaced indices) ; line → real time scale.
        // #p3hm5c — a bar is CENTRED on its index, so with the default range
        // [0, n-1] the first and last ones straddle the plot edge and get
        // clipped down the middle. Widen the scale by half a slot on each side
        // so every bar owns a full slot inside the plot area.
        scales: {
            x: bars
                ? { time: false, range: (): [number, number] => [-0.5, Math.max(0.5, nPts - 0.5)] }
                : { time: true },
        },
        series: [
            // x series: in bars mode the legend must show the timestamp behind
            // the hovered index, not the raw index number.
            bars ? { value: (_u: uPlot, v: number) => tsAt(v) } : {},
            ...props.series.map((s, i) => {
                const color = colors[i % colors.length];
                const base = {
                    label: s.label,
                    stroke: color,
                    width: 2,
                    value: (_u: uPlot, v: number | null) => (v == null ? "--" : Number(v).toLocaleString()),
                };
                // #1232/#1247 — bars mode: one full-slot bar per series, drawn in
                // order over each other, plotting cumulative heights = a stack.
                // No px cap on size (#jt9jtj) so bars fill their (uniform, ordinal)
                // slot instead of going thin on sparse data. Opaque fill is what
                // makes the overpaint carve out each segment.
                if (bars) {
                    return {
                        ...base,
                        paths: uPlot.paths!.bars!({ size: [0.9], gap: 1 }),
                        fill: color,
                        points: { show: false },
                        // the plotted value is the cumulative height — show the raw one.
                        value: (_u: uPlot, _v: number | null, sidx: number, didx: number | null) => {
                            const raw = didx == null ? null : curRaw[sidx - 1]?.[didx];
                            return raw == null ? "--" : Number(raw).toLocaleString();
                        },
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
                // bars: map ordinal index splits back to time labels.
                ...(bars ? { values: (_u: uPlot, splits: number[]) => splits.map(tsAt) } : {}),
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
        // Bars use an ordinal x whose axis/legend closures capture `curTs`; a
        // bare setData would leave those labels stale, so rebuild in bars mode.
        if (plot && props.mode !== "bars") plot.setData(alignedData());
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

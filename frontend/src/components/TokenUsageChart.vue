<script setup lang="ts">
/**
 * #1200 — single-series token-usage-over-time line chart (inline SVG, no chart
 * lib). One series by design (total, or a scoped project) → no legend, the
 * title names it; one accent hue. Dataviz skill: thin 2px line, recessive
 * grid/axes, text in ink tokens (never the series color), hover crosshair +
 * tooltip, theme-token colors so light/dark both work.
 */
import { computed, ref } from "vue";

interface Pt { t: number; v: number }
const props = defineProps<{
    points: Pt[];
    /** y-axis / tooltip unit label, e.g. "tokens". */
    unit?: string;
}>();

// --- geometry (viewBox space; the SVG scales responsively) -----------------
const W = 720;
const H = 260;
const M = { top: 16, right: 18, bottom: 28, left: 56 };
const iw = W - M.left - M.right;
const ih = H - M.top - M.bottom;

const sorted = computed(() => [...props.points].sort((a, b) => a.t - b.t));
const xMin = computed(() => sorted.value.length ? sorted.value[0].t : 0);
const xMax = computed(() => sorted.value.length ? sorted.value[sorted.value.length - 1].t : 1);
const yMax = computed(() => Math.max(1, ...sorted.value.map((p) => p.v)));

function sx(t: number): number {
    const span = xMax.value - xMin.value || 1;
    return M.left + ((t - xMin.value) / span) * iw;
}
function sy(v: number): number {
    return M.top + ih - (v / yMax.value) * ih;
}

const linePath = computed(() => {
    if (!sorted.value.length) return "";
    return sorted.value.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(" ");
});

// --- ticks (recessive) -----------------------------------------------------
function niceNum(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(n));
}
const yTicks = computed(() => {
    const n = 4;
    return Array.from({ length: n + 1 }, (_, i) => {
        const v = (yMax.value / n) * i;
        return { v, y: sy(v), label: niceNum(v) };
    });
});
const xTicks = computed(() => {
    const pts = sorted.value;
    if (pts.length < 2) return pts.map((p) => ({ x: sx(p.t), label: fmtDate(p.t) }));
    const n = Math.min(5, pts.length);
    return Array.from({ length: n }, (_, i) => {
        const t = xMin.value + ((xMax.value - xMin.value) / (n - 1)) * i;
        return { x: sx(t), label: fmtDate(t) };
    });
});
function fmtDate(t: number): string {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtFull(t: number): string {
    const d = new Date(t);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// --- hover crosshair + tooltip ---------------------------------------------
const hoverIdx = ref<number | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
function onMove(e: MouseEvent): void {
    const pts = sorted.value;
    if (!pts.length || !svgEl.value) return;
    const rect = svgEl.value.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W; // to viewBox x
    // nearest point by x
    let best = 0, bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(sx(pts[i].t) - px);
        if (d < bestD) { bestD = d; best = i; }
    }
    hoverIdx.value = best;
}
const hover = computed(() => (hoverIdx.value === null ? null : sorted.value[hoverIdx.value]));
</script>

<template>
    <div class="tuc">
        <svg
            ref="svgEl"
            class="tuc__svg"
            :viewBox="`0 0 ${W} ${H}`"
            preserveAspectRatio="none"
            role="img"
            @mousemove="onMove"
            @mouseleave="hoverIdx = null"
        >
            <!-- recessive grid + y ticks -->
            <g class="tuc__grid">
                <template v-for="tk in yTicks" :key="'y' + tk.v">
                    <line :x1="M.left" :y1="tk.y" :x2="W - M.right" :y2="tk.y" />
                    <text :x="M.left - 8" :y="tk.y + 3" text-anchor="end" class="tuc__axis">{{ tk.label }}</text>
                </template>
            </g>
            <!-- x ticks -->
            <g>
                <text
                    v-for="(tk, i) in xTicks"
                    :key="'x' + i"
                    :x="tk.x"
                    :y="H - 8"
                    text-anchor="middle"
                    class="tuc__axis"
                >{{ tk.label }}</text>
            </g>
            <!-- the series -->
            <path :d="linePath" class="tuc__line" fill="none" />
            <!-- hover crosshair + marker -->
            <g v-if="hover">
                <line :x1="sx(hover.t)" :y1="M.top" :x2="sx(hover.t)" :y2="M.top + ih" class="tuc__cross" />
                <circle :cx="sx(hover.t)" :cy="sy(hover.v)" r="4" class="tuc__dot" />
            </g>
        </svg>
        <div v-if="hover" class="tuc__tip" :style="{ left: (sx(hover.t) / W * 100) + '%' }">
            <div class="tuc__tip-v">{{ hover.v.toLocaleString() }}<span v-if="unit"> {{ unit }}</span></div>
            <div class="tuc__tip-t">{{ fmtFull(hover.t) }}</div>
        </div>
        <div v-if="!sorted.length" class="tuc__empty">
            No snapshots yet — the series builds up as the daemon captures token usage over time.
        </div>
    </div>
</template>

<style scoped>
.tuc { position: relative; width: 100%; }
.tuc__svg { width: 100%; height: 260px; display: block; overflow: visible; }
/* recessive grid + axes — ink tokens, never the series color */
.tuc__grid line { stroke: var(--p-content-border-color, #e5e7eb); stroke-width: 1; opacity: 0.6; }
.tuc__axis { fill: var(--p-text-muted-color, #9ca3af); font-size: 11px; font-family: var(--font-mono, monospace); }
.tuc__line { stroke: var(--p-primary-color, #3b82f6); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tuc__cross { stroke: var(--p-text-muted-color, #9ca3af); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.7; }
.tuc__dot { fill: var(--p-primary-color, #3b82f6); stroke: var(--p-content-background, #fff); stroke-width: 2; }
.tuc__tip {
    position: absolute; top: 0; transform: translateX(-50%);
    background: var(--p-content-background, #fff);
    border: 1px solid var(--p-content-border-color, #e5e7eb);
    border-radius: 6px; padding: 0.3rem 0.5rem; pointer-events: none;
    box-shadow: 0 2px 8px rgba(0,0,0,0.12); white-space: nowrap;
}
.tuc__tip-v { font-weight: 600; font-size: var(--fs-sm, 0.85rem); color: var(--p-text-color); }
.tuc__tip-t { font-size: 0.72rem; color: var(--p-text-muted-color, #9ca3af); }
.tuc__empty { padding: 2rem 1rem; text-align: center; color: var(--p-text-muted-color, #9ca3af); font-size: var(--fs-sm, 0.85rem); }
</style>

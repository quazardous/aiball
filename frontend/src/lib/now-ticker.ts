/**
 * useNowTicker — shared reactive tick-clock (UI-audit C2, slice 3).
 *
 * Collapses the three identical `nowTimer = setInterval(...)` blocks
 * (ConsumersPanel 6s, NodesPanel/NodeDetailPage 15s) that existed only to
 * repaint "Xs ago" labels without refetching. Returns a `now` ref updated
 * every `intervalMs`; cleanup is self-registered. Optional `onTick` runs
 * after each update (ConsumersPanel piggybacks its periodic refetch on it).
 */
import { onMounted, onUnmounted, type Ref, ref } from "vue";

export function useNowTicker(intervalMs: number, onTick?: (nowMs: number) => void): Ref<number> {
    const now = ref(Date.now());
    let timer: ReturnType<typeof setInterval> | null = null;
    onMounted(() => {
        timer = setInterval(() => {
            now.value = Date.now();
            onTick?.(now.value);
        }, intervalMs);
    });
    onUnmounted(() => {
        if (timer) clearInterval(timer);
    });
    return now;
}

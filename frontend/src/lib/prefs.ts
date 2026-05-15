/**
 * Cross-component user preferences (#B.133). Lightweight: a single
 * module-scope `ref` per pref, synced to localStorage. Anything that
 * imports the ref participates in the same reactive state — toggle
 * from the header and the thread re-renders.
 */
import { ref, watch } from "vue";

const TOP_DOWN_KEY = "aiball.thread_top_down";

export const topDown = ref(localStorage.getItem(TOP_DOWN_KEY) === "1");

watch(topDown, (v) => {
    localStorage.setItem(TOP_DOWN_KEY, v ? "1" : "0");
});

export function toggleTopDown(): void {
    topDown.value = !topDown.value;
}

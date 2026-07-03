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

// #B.123 follow-up: how the promote-to-typed-relation popover is
// triggered on a `#B.NN` link in a rendered body. "hover" = popover
// shows when the mouse enters the link (default — david's pref);
// "contextmenu" = popover shows on right-click. Persisted globally.
const PROMOTE_TRIGGER_KEY = "aiball.promote_trigger";
type PromoteTrigger = "hover" | "contextmenu";
const stored = localStorage.getItem(PROMOTE_TRIGGER_KEY);
export const promoteTrigger = ref<PromoteTrigger>(
    stored === "contextmenu" ? "contextmenu" : "hover",
);
watch(promoteTrigger, (v) => {
    localStorage.setItem(PROMOTE_TRIGGER_KEY, v);
});

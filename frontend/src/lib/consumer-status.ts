/**
 * #460 — pure formatters for a consumer/loop's live state, shared between
 * any page that displays the same ld-tag chips (currently ProjectDetailPage
 * and ConsumerEditPage). The corresponding CSS classes live globally in
 * `style.css` (`.ld-tag` + `.ld-tag--*`).
 *
 * Pure functions, no Vue state — extracted as a utility module, not a
 * composable, per #458 decision (only layout-bound composables, no logic
 * composables).
 */

/** Activity tag for the loop's `state` (busy / boot / idle). */
export function activityClass(state?: string | null): string {
    if (state === "busy") return "ld-tag--busy";
    if (state === "boot") return "ld-tag--boot";
    return "ld-tag--idle";
}

/**
 * 3-state presence word: stop / wait (= ask/human) / loop. Falls back to
 * the legacy binary `state_human` flag when the explicit `word` (#310) is
 * absent (= loop predates the 3-state field).
 */
export function presenceWord(human?: boolean | null, word?: string | null): string {
    return word ?? (human ? "human" : "loop");
}

/** Coloured ld-tag class for the presence word. */
export function presenceClass(human?: boolean | null, word?: string | null): string {
    const w = presenceWord(human, word);
    if (w === "stop") return "ld-tag--stop";
    // #426 — `ask` (ASK-grace) shares the grace-state tint on this coarser web view.
    if (w === "wait" || w === "human" || w === "ask") return "ld-tag--wait";
    return "ld-tag--loop";
}

<script setup lang="ts">
import type { Priority } from "../lib/api";

defineProps<{ priority: Priority }>();

// #632 david `atvf3q` : Google Material Symbols inlined as SVG paths (no
// font dep, no CDN — keeps the bundle small and works offline).
//   urgent : `arrow_shape_up_stack` — two stacked filled chevrons
//   high   : `arrow_shape_up`       — single filled chevron
//   low    : `low_priority`         — official low-priority glyph
//   normal : null (caller skips render)
// Material Symbols Outlined 24px. Filled-shape series reads as a chunkier
// weight ladder vs the previous keyboard_arrow chevrons.
const PATHS: Record<Priority, string | null> = {
    // arrow_shape_up_stack — bottom chevron + top chevron (filled triangular shapes)
    urgent: "M12 2l-7 7h4v3h6V9h4l-7-7zm-7 13l7 7 7-7h-4v-3H9v3H5z",
    // arrow_shape_up — single filled up chevron with stem
    high: "M12 4l-8 8h5v8h6v-8h5l-8-8z",
    normal: null,
    // low_priority — three horizontal bars + curved arrow underneath
    low: "M14 5h8v2h-8V5zm0 5.5h8v2h-8v-2zm0 5.5h8v2h-8v-2zM2 11.5C2 15.08 4.92 18 8.5 18H9v2l3-3-3-3v2h-.5C6.02 16 4 13.98 4 11.5S6.02 7 8.5 7H12V5H8.5C4.92 5 2 7.92 2 11.5z",
};
</script>

<template>
    <svg
        v-if="PATHS[priority]"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="currentColor"
        aria-hidden="true"
    >
        <path :d="PATHS[priority]!" />
    </svg>
</template>

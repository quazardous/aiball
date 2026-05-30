<script setup lang="ts">
import type { Priority } from "../lib/api";

defineProps<{ priority: Priority }>();

// #632 david `qjmg84` : Google Material Symbols chevrons inlined as SVG
// paths (no font dep, no CDN — keeps the bundle small and works offline).
// Paths from Material Symbols Outlined 24px : keyboard_double_arrow_up
// / keyboard_arrow_up / keyboard_arrow_down. `normal` stays null — the
// caller is expected to skip rendering for the default.
const PATHS: Record<Priority, string | null> = {
    urgent: "M6 17.59 7.41 19 12 14.41 16.59 19 18 17.59l-6-6zM6 11 7.41 12.41 12 7.83 16.59 12.41 18 11l-6-6z",
    high: "M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z",
    normal: null,
    low: "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z",
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

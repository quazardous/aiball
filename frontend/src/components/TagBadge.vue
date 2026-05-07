<script setup lang="ts">
import { computed } from "vue";
import type { Tag } from "../lib/api";

const props = defineProps<{
    tag: Tag;
    removable?: boolean;
    size?: "sm" | "md";
}>();
const emit = defineEmits<{ (e: "remove", tag: Tag): void }>();

// Compute readable foreground color from the tag's hex (very rough — sRGB
// luminance). Falls back to neutral when the tag has no color.
const fg = computed(() => {
    const hex = props.tag.color ?? "";
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.replace(/^#/, ""));
    if (!m) return "var(--p-text-color)";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 0xff;
    const g = (n >> 8) & 0xff;
    const b = n & 0xff;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 160 ? "#111" : "#fff";
});
const bg = computed(() => props.tag.color ?? "var(--p-surface-200)");
</script>

<template>
    <span
        class="tag-badge"
        :class="`tag-badge--${size ?? 'md'}`"
        :style="{ background: bg, color: fg }"
        :title="tag.note ?? tag.name"
    >
        <span>{{ tag.name }}</span>
        <button
            v-if="removable"
            type="button"
            class="tag-badge__x"
            :style="{ color: fg }"
            @click.stop="emit('remove', tag)"
            :title="`remove ${tag.name}`"
        >
            <i class="pi pi-times" />
        </button>
    </span>
</template>

<style>
.tag-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.3rem;
    white-space: nowrap;
}
.tag-badge--sm {
    font-size: 0.7rem;
    padding: 0.02rem 0.4rem;
    line-height: 1.1rem;
}
.tag-badge__x {
    background: transparent;
    border: 0;
    cursor: pointer;
    opacity: 0.7;
    padding: 0;
    display: inline-flex;
    align-items: center;
    font-size: 0.7em;
}
.tag-badge__x:hover {
    opacity: 1;
}
</style>

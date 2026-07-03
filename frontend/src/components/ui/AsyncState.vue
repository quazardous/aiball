<script setup lang="ts">
/**
 * AsyncState — the shared Loading / Error / Empty triad (UI-audit C3).
 *
 * Collapses the block hand-rolled across the admin screens :
 *
 *   <div v-if="loading" class="aiball-empty">Loading…</div>
 *   <div v-else-if="error" class="aiball-empty" style="color: red">{{ error }}</div>
 *   <div v-else-if="empty" class="aiball-empty">…empty copy…</div>
 *   …content…
 *
 * Usage :
 *   <AsyncState :loading="loading" :error="error" :empty="rows.length === 0">
 *     <template #empty>No launchers configured. …rich copy…</template>
 *     …content (default slot, rendered when loaded & non-empty)…
 *   </AsyncState>
 *
 * `empty` is optional — omit it (default false) when the screen has no
 * empty concept and the default slot should render as soon as the load
 * settles. DataList keeps its own built-in states for tables ; this is
 * the page/section-level wrapper.
 */
defineProps<{
    loading: boolean;
    error?: string | null;
    empty?: boolean;
}>();
</script>

<template>
    <div v-if="loading" class="aiball-empty">Loading…</div>
    <div v-else-if="error" class="aiball-empty aiball-empty--error">{{ error }}</div>
    <div v-else-if="empty" class="aiball-empty"><slot name="empty" /></div>
    <slot v-else />
</template>

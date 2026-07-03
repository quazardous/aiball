<script setup lang="ts">
/**
 * SectionHeader — the in-page `<h3> + hint` pair (UI-audit C3).
 *
 * Collapses the section headers hand-rolled per screen (each with its own
 * heading/hint classes : `general-settings__heading`, `project-settings__hint`,
 * bare `<h3>` + `aiball-explainer`, …) into one shape riding the existing
 * `.aiball-section h3` sizing + `.aiball-explainer` hint styling.
 *
 * Usage :
 *   <SectionHeader title="Moderation strategy">
 *     Daemon-wide default for how new tickets are moderated…
 *   </SectionHeader>
 *
 * Rich titles (markup inside the h3) go through the #title slot instead of
 * the prop ; the default slot is the hint (omit it for a bare heading).
 * `actions` slot renders right-aligned on the heading row (uses the existing
 * `.aiball-section__head` flex row).
 */
defineProps<{ title?: string }>();
</script>

<template>
    <div class="aiball-section__head">
        <h3><slot name="title">{{ title }}</slot></h3>
        <slot name="actions" />
    </div>
    <p v-if="$slots.default" class="aiball-explainer"><slot /></p>
</template>

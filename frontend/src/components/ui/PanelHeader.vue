<script setup lang="ts">
/**
 * #453 — En-tête de panel admin partagé (pattern qdadm `PageHeader`, scalé).
 *
 * Structure unifiée : un titre, un slot `#actions` (boutons alignés à droite),
 * et le slot par défaut pour le(s) paragraphe(s) d'explication
 * (`<p class="aiball-explainer">…</p>`).
 *
 * Remplace le `<header class="rules-header">` / `.rules-explainer-block`
 * dupliqué dans les panels et stoppe la fuite globale des classes
 * `.rules-explainer*` (jadis définies non-scopées dans RulesPanel et utilisées
 * par 6 panels). Les styles vivent dans style.css (`.aiball-panel-head*`,
 * `.aiball-explainer*`).
 *
 * Usage :
 *   <PanelHeader title="Consumers">
 *     <p class="aiball-explainer aiball-explainer--muted">…</p>
 *   </PanelHeader>
 *
 *   <PanelHeader title="Projects">
 *     <template #actions><Button … /></template>
 *     <p class="aiball-explainer aiball-explainer--muted">…</p>
 *   </PanelHeader>
 */
defineProps<{ title: string }>();
</script>

<template>
    <header class="aiball-panel-head">
        <div class="aiball-panel-head__bar">
            <h2 class="aiball-panel-head__title">{{ title }}</h2>
            <div v-if="$slots.actions" class="aiball-panel-head__actions">
                <slot name="actions" />
            </div>
        </div>
        <slot />
    </header>
</template>

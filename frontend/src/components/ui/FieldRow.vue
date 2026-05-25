<script setup lang="ts">
/**
 * #453 — Ligne de champ read-only label/valeur (pattern qdadm `ShowField`,
 * scalé) pour les pages détail. Label au-dessus, valeur en slot (texte simple,
 * ou un `<span class="aiball-mono">` pour un id/token).
 *
 * Adossé aux classes globales `.aiball-field-row*` (style.css). Remplace les
 * `<div class="…__field"><label>…</label><div class="…__value">…</div></div>`
 * dupliqués dans NodeDetailPage / ConsumerEditPage.
 *
 * Usage :
 *   <FieldRow label="last peer IP">{{ ip ?? "—" }}</FieldRow>
 *   <FieldRow label="node id"><span class="aiball-mono">{{ id }}</span></FieldRow>
 */
defineProps<{ label: string }>();
</script>

<template>
    <div class="aiball-field-row">
        <label class="aiball-field-row__label">{{ label }}</label>
        <div class="aiball-field-row__value"><slot /></div>
    </div>
</template>

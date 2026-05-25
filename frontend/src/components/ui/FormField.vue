<script setup lang="ts">
/**
 * #453 — Champ de formulaire admin partagé (pattern qdadm `FormField`, scalé).
 *
 * Label optionnel au-dessus d'un input fourni en slot. Adossé à la classe
 * globale `.aiball-field` (style.css). Remplace les `<div class="builder-cond">
 * <label class="field-label">…</label> …input…</div>` dupliqués dans les panels
 * de config (Rules / Tags / WorkFilters).
 *
 * Usage :
 *   <FormField label="name">
 *     <InputText v-model="name" class="w-full" />
 *   </FormField>
 *
 * Sans `label`, c'est juste la colonne `.aiball-field` (utile pour aligner un
 * bouton en bas d'une rangée `.aiball-form-grid`).
 */
defineProps<{ label?: string }>();
</script>

<template>
    <div class="aiball-field">
        <label v-if="label" class="field-label">{{ label }}</label>
        <slot />
    </div>
</template>

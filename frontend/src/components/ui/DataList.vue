<script setup lang="ts">
/**
 * #453 — Coquille de liste/table admin partagée (pattern qdadm `ListPage`,
 * scalé à aiball).
 *
 * Porte le wrap + le look canonique `.aiball-table` (style.css) + le trio
 * d'états loading/error/empty, pour que les panels arrêtent de redéclarer le
 * même CSS de table et les mêmes trois blocs d'état.
 *
 * Usage :
 *   <DataList :loading="loading" :error="error" :is-empty="!rows.length">
 *     <template #empty> ...état vide custom (icône, message)... </template>
 *     <template #head> <th>…</th> … </template>
 *     <template #body> <tr v-for=…> … </tr> </template>
 *   </DataList>
 *
 * `#empty` est optionnel : sans lui un message neutre s'affiche. `#head`/`#body`
 * laissent au panel le contrôle total des colonnes et des lignes (markup,
 * classes, events) — la coquille ne fait que la structure + le look.
 *
 * `tableClass` ajoute une classe sur la `<table>` (en plus de `.aiball-table`)
 * pour que les tables complexes gardent leurs deltas scopés (responsive, tri,
 * colonnes spécifiques) via `.<tableClass> …` sans réécrire leurs sélecteurs.
 */
defineProps<{
    loading?: boolean;
    error?: string | null;
    isEmpty?: boolean;
    tableClass?: string;
}>();
</script>

<template>
    <div class="aiball-table-wrap">
        <div v-if="loading" class="aiball-empty">
            <slot name="loading">Loading…</slot>
        </div>
        <div v-else-if="error" class="aiball-empty aiball-empty--error">{{ error }}</div>
        <slot v-else-if="isEmpty" name="empty">
            <div class="aiball-empty">Nothing here.</div>
        </slot>
        <table v-else class="aiball-table" :class="tableClass">
            <thead>
                <tr><slot name="head" /></tr>
            </thead>
            <tbody>
                <slot name="body" />
            </tbody>
        </table>
    </div>
</template>

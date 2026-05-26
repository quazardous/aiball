<script setup lang="ts">
/**
 * #458 — Layout standard pour les pages détail "dashboard" (full-width,
 * plusieurs sections / tableaux / graphiques, pas de body carté).
 *
 * Niveau 2 (jumeau de <AdminDetailLayout>, version multi-section) :
 *
 *   App.vue (.aiball-main)                              ← level 1
 *     └─ <AdminDashboardLayout>                         ← level 2 (CE COMPOSANT)
 *          breadcrumb (DetailHeader) + gouttière
 *          └─ ProjectDetailPage / ProjectStatsPage      ← level 3
 *
 * Différence vs <AdminDetailLayout> : pas de carte autour du corps, pas de
 * max-width local (la page prend les 980px de `.aiball-main`), et une
 * gouttière verticale standard entre les enfants directs du slot par
 * défaut — la page n'a plus à déclarer `display:flex; gap:1rem;` elle-même.
 *
 * API miroir de <AdminDetailLayout>.
 */
import DetailHeader from "./DetailHeader.vue";

interface Crumb {
    label: string;
    href?: string;
}
defineProps<{
    crumbs: Crumb[];
    current: string;
    title?: string;
}>();
const emit = defineEmits<{
    (e: "close-to-inbox"): void;
    (e: "close-to-list"): void;
}>();

function onCrumb(index: number): void {
    if (index === 0) emit("close-to-inbox");
    else emit("close-to-list");
}
</script>

<template>
    <div class="aiball-dashboard-page">
        <DetailHeader
            :crumbs="crumbs"
            :current="current"
            :title="title"
            @crumb="onCrumb"
        >
            <template v-if="$slots.actions" #actions>
                <slot name="actions" />
            </template>
        </DetailHeader>

        <slot />
    </div>
</template>

<style>
/* Page dashboard full-width avec gouttière verticale uniforme entre les
   sections. La page concrète n'a plus à poser un flex column / gap. */
.aiball-dashboard-page {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
</style>

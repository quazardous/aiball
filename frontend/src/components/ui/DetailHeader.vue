<script setup lang="ts">
/**
 * #454 — En-tête de page détail/edit unifié : un **breadcrumb** (fil d'Ariane)
 * + un titre + un slot `#actions`. Système breadcrumb commun à toutes les pages
 * détail (Node / Consumer / Project*), en remplacement des headers bespoke
 * (`.X__crumbs` / `.X__header` / `.X__back`).
 *
 * `crumbs` = la trace des parents (cliquables) ; `current` = la feuille (non
 * cliquable, ex. l'id de l'entité ou le nom du projet). Un clic sur un crumb
 * émet `crumb` avec son index — la page décide où ça mène (router/emit).
 *
 * Usage :
 *   <DetailHeader
 *     :crumbs="[{ label: 'Proxy nodes' }]"
 *     :current="nodeId"
 *     title="Node details"
 *     @crumb="emit('close')"
 *   >
 *     <template #actions><Button … /></template>
 *   </DetailHeader>
 */
interface Crumb {
    label: string;
}
defineProps<{
    crumbs: Crumb[];
    current: string;
    title?: string;
}>();
const emit = defineEmits<{ (e: "crumb", index: number): void }>();
</script>

<template>
    <div class="aiball-detail-head">
        <nav class="aiball-breadcrumb">
            <template v-for="(c, i) in crumbs" :key="i">
                <button type="button" class="aiball-breadcrumb__link" @click="emit('crumb', i)">
                    <i v-if="i === 0" class="pi pi-arrow-left" /> {{ c.label }}
                </button>
                <span class="aiball-breadcrumb__sep">/</span>
            </template>
            <span class="aiball-breadcrumb__current">{{ current }}</span>
        </nav>
        <header v-if="title || $slots.actions" class="aiball-detail-head__bar">
            <h2 class="aiball-detail-head__title">{{ title }}</h2>
            <div v-if="$slots.actions" class="aiball-detail-head__actions">
                <slot name="actions" />
            </div>
        </header>
    </div>
</template>

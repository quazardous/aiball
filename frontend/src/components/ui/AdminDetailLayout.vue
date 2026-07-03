<script setup lang="ts">
/**
 * #458 — Layout standard pour les pages détail "form-style" (focused, narrow,
 * 1 entité, body en carte).
 *
 * Niveau 2 du pattern d'héritage 3-niveaux (réplique aiball-native de
 * qdadm/FormLayout) :
 *
 *   App.vue (.aiball-main)                              ← level 1
 *     └─ <AdminDetailLayout>                            ← level 2 (CE COMPOSANT)
 *          breadcrumb (DetailHeader) + body card
 *          └─ NodeDetailPage / ConsumerEditPage / …    ← level 3 (la page concrète,
 *                                                         ne pose plus les classes
 *                                                         de layout elle-même)
 *
 * Les pages détail ne doivent PLUS poser leur propre max-width / padding /
 * gouttière — tout vit ici. Pour ajouter un champ commun à toutes les pages
 * détail form-style (ex : un loader standard, un bandeau "modifié"), 1 ligne
 * dans CE fichier suffit.
 *
 * API :
 *   <AdminDetailLayout
 *     :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Consumers', href: '/consumers' }]"
 *     :current="consumerId"
 *     title="Edit consumer"
 *     @close-to-inbox="…"
 *     @close-to-list="…"
 *   >
 *     <template #actions><Button … /></template>
 *
 *     <!-- default slot = corps de la page, déjà dans la carte -->
 *     <FieldRow … />
 *     <FieldRow … />
 *   </AdminDetailLayout>
 *
 * `close-to-inbox` = clic sur le 1er crumb (Inbox) ;
 * `close-to-list`  = clic sur un crumb suivant (parent direct). Pour qu'une
 * page n'ait à brancher qu'UN seul handler, on dispatche par index pour elle.
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
    <div class="aiball-detail-page">
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

        <!-- Corps de la page, encarté par défaut (mêmes bordures / fond /
             padding qu'avant la mutualisation). Une page qui n'aurait pas
             besoin du carté peut passer par <AdminDashboardLayout>. -->
        <div class="aiball-detail-page__body">
            <slot />
        </div>
    </div>
</template>

<style>
/* Corps encarté standard pour <AdminDetailLayout>. Conserve le rendu
   identique aux .{node,consumer}-edit__body bespoke qu'il remplace. */
.aiball-detail-page__body {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--radius-lg);
    background: var(--p-content-background);
}
</style>

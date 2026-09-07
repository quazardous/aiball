<script setup lang="ts">
/**
 * #502 — petite pastille colorée (dot + label) pour signaler l'état liveness
 * d'une ressource. Aujourd'hui utilisée par NodesPanel + NodeDetailPage pour
 * indiquer si un proxy node bat encore (heartbeat 30s → ≤ 90s = vert).
 *
 * Indépendant du domaine : si demain on en a besoin pour un autre statut
 * (loop alive, daemon up, …), le composant accepte 3 statuts génériques + un
 * label. Garde le ld-tag system (chips agent state) intact — c'est une autre
 * UX (chip rectangulaire VS dot rond).
 */
/** `error` (#2082) : un état négatif VOULU — quelque chose a été refusé ou a
 *  échoué, par opposition à `down` qui ne dit que « pas là ». Rouge estompé :
 *  il informe, il n'alarme pas. */
type Status = "up" | "stale" | "down" | "error";
defineProps<{
    status: Status;
    /** Texte affiché à droite du dot. Si vide, le dot seul s'affiche. */
    label?: string;
    /** Tooltip natif (title=) — typiquement "last activity 12s ago". */
    title?: string;
}>();
</script>

<template>
    <span class="aiball-pill" :class="`aiball-pill--${status}`" :title="title">
        <span class="aiball-pill__dot" aria-hidden="true" />
        <span v-if="label" class="aiball-pill__label">{{ label }}</span>
    </span>
</template>

<style scoped>
.aiball-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: var(--fs-xs);
    line-height: 1;
}
.aiball-pill__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08) inset;
}
.aiball-pill__label {
    font-weight: 500;
    color: var(--p-surface-600, #475569);
}
.aiball-pill--up   .aiball-pill__dot { background: var(--p-green-500,  #22c55e); }
.aiball-pill--stale .aiball-pill__dot { background: var(--p-yellow-500, #eab308); }
.aiball-pill--down .aiball-pill__dot { background: var(--p-surface-400, #9ca3af); }
.aiball-pill--error .aiball-pill__dot { background: var(--p-red-400, #f87171); }
/* Le label suit la couleur, en atténué : « refusé » doit se lire comme une
   information, pas comme une alerte. */
.aiball-pill--error .aiball-pill__label { color: var(--p-red-400, #f87171); }
</style>

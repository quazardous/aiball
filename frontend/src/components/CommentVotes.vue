<script setup lang="ts">
import { computed, ref } from "vue";
import { useToast } from "primevue/usetoast";
import { api, type Message } from "../lib/api";

const props = defineProps<{
    msg: Message;
}>();
/**
 * Post-vote refresh is the parent's business (bus fan-out to thread /
 * inbox / sidebar) — we just signal that a vote landed.
 */
const emit = defineEmits<{
    refresh: [];
}>();

const toast = useToast();
const voteBusy = ref(false);

// #518 (david `uzwfc3` option A) — vote state pour ce comment. Lit
// `votes_summary` injecté par le backend (par viewer-aware request) ;
// fallback à un calcul local quand le payload n'a pas le champ (cas
// d'un WS broadcast cross-user où le `mine` du sender n'est pas le tien).
const myConsumerId = computed<string>(() => localStorage.getItem("aiball.human_id") ?? "");
const votesSummary = computed(() => {
    if (props.msg.votes_summary) return props.msg.votes_summary;
    // Fallback : recompute depuis meta.votes (présent dans le payload même
    // sur les broadcasts WS). Meta est typé loose côté front, on parse.
    type LooseMeta = { votes?: Record<string, 1 | -1> };
    const raw = (props.msg as unknown as { meta?: LooseMeta | string | null }).meta;
    let parsed: LooseMeta = {};
    if (typeof raw === "string" && raw) {
        try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
    } else if (raw && typeof raw === "object") {
        parsed = raw;
    }
    const votes = parsed.votes ?? {};
    let up = 0;
    let down = 0;
    let mine: 1 | -1 | null = null;
    for (const [voter, v] of Object.entries(votes)) {
        if (v === 1) up += 1;
        else if (v === -1) down += 1;
        if (voter === myConsumerId.value) mine = v;
    }
    return { up, down, mine };
});

async function vote(direction: 1 | -1) {
    if (voteBusy.value) return;
    voteBusy.value = true;
    try {
        // Toggle : si on a déjà voté pareil, on retract (value=0). Sinon on
        // pose le vote (flip d'une opposite ou nouveau vote).
        const value: 1 | -1 | 0 = votesSummary.value.mine === direction ? 0 : direction;
        await api.voteOnMessage(props.msg.id, value);
        emit("refresh");
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Vote failed",
            detail: e instanceof Error ? e.message : String(e),
            life: 4000,
        });
    } finally {
        voteBusy.value = false;
    }
}
</script>

<template>
    <!-- #518 (david `uzwfc3` option A + `7b3jc7` style update) —
         votes binaires +1/-1. Pas de border button, juste l'icône
         en couleur (muted par défaut, accent green/red quand voté).
         Re-cliquer même direction retract (toggle). Pas de fan-out. -->
    <span class="comment-votes" :class="{ 'comment-votes--busy': voteBusy }">
        <button
            type="button"
            class="comment-vote-btn comment-vote-btn--up"
            :class="{ 'comment-vote-btn--mine': votesSummary.mine === 1 }"
            :disabled="voteBusy"
            :title="votesSummary.mine === 1 ? 'Retract your up-vote' : 'Up-vote this comment'"
            @click="vote(1)"
        >
            <i class="pi pi-thumbs-up" />
            <span v-if="votesSummary.up > 0" class="comment-vote-count">{{ votesSummary.up }}</span>
        </button>
        <button
            type="button"
            class="comment-vote-btn comment-vote-btn--down"
            :class="{ 'comment-vote-btn--mine': votesSummary.mine === -1 }"
            :disabled="voteBusy"
            :title="votesSummary.mine === -1 ? 'Retract your down-vote' : 'Down-vote this comment'"
            @click="vote(-1)"
        >
            <i class="pi pi-thumbs-down" />
            <span v-if="votesSummary.down > 0" class="comment-vote-count">{{ votesSummary.down }}</span>
        </button>
    </span>
</template>

<style scoped>
/* #518 (david `7b3jc7`) — vote buttons inline footer. Pas de border button,
   juste l'icône. Muted neutre par défaut, accent vert (up) / rouge (down)
   quand l'utilisateur a voté. */
.comment-votes {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
}
.comment-votes--busy { opacity: 0.6; }
.comment-vote-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--p-text-muted-color);
    font-size: 0.95rem;
    cursor: pointer;
    transition: color 120ms;
}
.comment-vote-btn:hover:not(:disabled) {
    color: var(--p-text-color);
}
.comment-vote-btn--up.comment-vote-btn--mine { color: var(--p-green-500); }
.comment-vote-btn--down.comment-vote-btn--mine { color: var(--p-red-500); }
.comment-vote-btn:disabled { cursor: progress; }
.comment-vote-count {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: var(--fs-sm);
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Select from "primevue/select";
import { api, type Strategy } from "../lib/api";
import { useLoader } from "../lib/loader";
import { STRATEGY_OPTIONS } from "../lib/labels";
import ManagedConfig from "./ManagedConfig.vue";
import AdminDashboardLayout from "./ui/AdminDashboardLayout.vue";
import AsyncState from "./ui/AsyncState.vue";
import SectionHeader from "./ui/SectionHeader.vue";

const props = defineProps<{
    project: string;
    /** #471 — embed mode (no own breadcrumb). */
    embedded?: boolean;
}>();

const emit = defineEmits<{
    (e: "back"): void;
}>();

// Strategy override state (#B.127). `strategy === null` means "follow
// the global". Picker uses a sentinel "_global" value because Select
// can't bind to null directly.
const strategy = ref<Strategy | null>(null);
const strategyGlobal = ref<Strategy>("auto-reply");
const strategyBusy = ref(false);
const error = ref<string | null>(null);
const GLOBAL_SENTINEL = "_global";
type StrategyChoice = Strategy | typeof GLOBAL_SENTINEL;
const strategyChoice = computed<StrategyChoice>({
    get: () => strategy.value ?? GLOBAL_SENTINEL,
    set: (v) => { void applyStrategy(v); },
});
const strategyOptions = computed(() => [
    {
        label: `Use global (currently: ${strategyGlobal.value})`,
        value: GLOBAL_SENTINEL as StrategyChoice,
        hint: "Project follows the daemon-wide strategy. Change the global in Settings → General.",
    },
    ...STRATEGY_OPTIONS.map((o) => ({
        label: o.label,
        value: o.value as StrategyChoice,
        hint: o.hint,
    })),
]);
async function applyStrategy(v: StrategyChoice) {
    strategyBusy.value = true;
    try {
        const next: Strategy | null = v === GLOBAL_SENTINEL ? null : v;
        const r = await api.setProjectStrategy(props.project, next);
        strategy.value = r.strategy;
        strategyGlobal.value = r.global;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        strategyBusy.value = false;
    }
}

const { loading, load } = useLoader(async () => {
    const r = await api.getProjectStrategy(props.project);
    strategy.value = r.strategy;
    strategyGlobal.value = r.global;
}, { error, mountLoad: true });

watch(() => props.project, () => load());
</script>

<template>
    <AdminDashboardLayout
        :crumbs="[{ label: 'Inbox', href: '/' }]"
        :current="project"
        title="Settings"
        :embedded="embedded"
        @close-to-inbox="emit('back')"
    >
        <AsyncState :loading="loading" :error="error">
            <section class="project-settings__section">
                <SectionHeader title="Moderation strategy">
                    Choose how new comments and tickets are moderated in
                    <strong>{{ project }}</strong>. Leave on "Use global" to
                    follow the daemon-wide default; override only when this
                    project needs a different policy.
                </SectionHeader>
                <Select
                    v-model="strategyChoice"
                    :options="strategyOptions"
                    option-label="label"
                    option-value="value"
                    :disabled="strategyBusy"
                    :title="strategy === null
                        ? `Project follows the global strategy (${strategyGlobal})`
                        : `Project override active — using “${strategy}” regardless of the global setting`"
                    class="project-settings__strategy-select"
                >
                    <template #option="{ option }">
                        <div class="project-settings__strategy-opt">
                            <div>{{ option.label }}</div>
                            <small>{{ option.hint }}</small>
                        </div>
                    </template>
                </Select>
                <div class="project-settings__state">
                    <template v-if="strategy === null">
                        Following global default:
                        <strong>{{ strategyGlobal }}</strong>
                    </template>
                    <template v-else>
                        Override active: <strong>{{ strategy }}</strong>
                        (global is <em>{{ strategyGlobal }}</em>)
                    </template>
                </div>
            </section>

            <!-- #449: project-scoped config keys (same component as Settings >
                 General, in project mode → "Use global (currently X)" semantics). -->
            <section class="project-settings__section">
                <SectionHeader title="Project config">
                    Override the project-scoped config keys for
                    <strong>{{ project }}</strong>. Leave a key on "Use global" to
                    follow the daemon-wide value.
                </SectionHeader>
                <ManagedConfig :project="project" />
            </section>
        </AsyncState>
    </AdminDashboardLayout>
</template>

<style>
/* Layout (largeur + gouttière + breadcrumb) → `<AdminDashboardLayout>` (#458). */
.project-settings__section {
    padding: 1rem 1.2rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    /* #474 david `eppmcx` : "la zone Project config est moin large que
       Danger-Zone". Une `max-width: 38rem` historique gardait les
       sections étroites sur desktop, alors que la Danger zone (rendue
       par ProjectOverviewPage en frère du composant) prend toute la
       largeur du conteneur. Sur la page Settings du Project Overview
       les 3 cards (Moderation strategy / Project config / Danger zone)
       doivent prendre la même largeur — on supprime la contrainte ici
       (le AdminDashboardLayout cap déjà le conteneur). La media query
       720px en dessous ajustait déjà à `max-width: none` sur mobile :
       elle devient redondante mais reste inoffensive. */
}
.project-settings__section h3 {
    margin: 0;
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--p-text-muted-color);
    font-weight: 600;
}
.project-settings__hint {
    margin: 0;
    font-size: 0.88rem;
    color: var(--p-text-muted-color);
}
.project-settings__strategy-select {
    min-width: 14rem;
}
.project-settings__strategy-opt small {
    display: block;
    color: var(--p-text-muted-color);
    font-size: 0.78rem;
    margin-top: 0.1rem;
}
.project-settings__state {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}

/* #B.254: lighten the layout on narrow viewports — shrink padding,
   collapse the section's max-width gate, trim the H2, full-width the
   strategy Select so it follows the section instead of the desktop
   min-width. */
@media (max-width: 720px) {
    .project-settings__section {
        padding: 0.7rem 0.8rem;
        max-width: none;
        gap: 0.4rem;
    }
    .project-settings__section h3 {
        font-size: 0.78rem;
    }
    .project-settings__hint {
        font-size: 0.82rem;
    }
    .project-settings__strategy-select {
        min-width: 0;
        width: 100%;
    }
    .project-settings__state {
        font-size: 0.8rem;
    }
}
</style>

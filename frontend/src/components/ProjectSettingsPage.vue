<script setup lang="ts">
import { computed, ref, watch } from "vue";
import Select from "primevue/select";
import { api, type Strategy } from "../lib/api";
import { useLoader } from "../lib/loader";
import { STRATEGY_OPTIONS } from "../lib/labels";
import { readStandingPromptHistory, rememberStandingPrompt } from "../lib/standing-prompt";
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

// #1832 — the standing instruction shown at the head of every wake on this
// project. Typed before going AFK ("priorité au debug léger, pas de grosse
// évolution"), cleared on return.
//
// A single-line <input>, not a <textarea>, on david's call: the widget is what
// keeps it short. The instruction rides on EVERY wake, so length is a running
// cost — a validator rejecting a long paste afterwards would be a worse way to
// say the same thing than a field that never invites one.
const standingPrompt = ref("");
const standingSaved = ref("");
const standingBusy = ref(false);

// History is shared with the header popover via lib/standing-prompt — one
// storage key and one dedup rule, so the two entry points cannot drift into
// suggesting different things.
const history = ref<string[]>([]);

async function applyStandingPrompt() {
    const next = standingPrompt.value.trim();
    if (next === standingSaved.value) return;
    standingBusy.value = true;
    try {
        const r = await api.setProjectStandingPrompt(props.project, next || null);
        standingSaved.value = r.standing_prompt ?? "";
        standingPrompt.value = standingSaved.value;
        history.value = rememberStandingPrompt(props.project, standingSaved.value);
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        standingBusy.value = false;
    }
}

const { loading, load } = useLoader(async () => {
    const [s, sp] = await Promise.all([
        api.getProjectStrategy(props.project),
        api.getProjectStandingPrompt(props.project),
    ]);
    strategy.value = s.strategy;
    strategyGlobal.value = s.global;
    standingSaved.value = sp.standing_prompt ?? "";
    standingPrompt.value = standingSaved.value;
    history.value = readStandingPromptHistory(props.project);
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
                <SectionHeader title="Standing instruction">
                    A short note prepended to <strong>every</strong> wake on
                    <strong>{{ project }}</strong> — event and backlog alike.
                    Leave one before stepping away
                    (&ldquo;priorité au debug léger, pas de grosse évolution&rdquo;)
                    and clear it when you are back. Empty means wakes read
                    exactly as they do today.
                </SectionHeader>
                <input
                    v-model="standingPrompt"
                    list="standing-prompt-history"
                    type="text"
                    class="project-settings__standing-input"
                    placeholder="e.g. priorité au debug léger, pas de grosse évolution"
                    :disabled="standingBusy"
                    @blur="applyStandingPrompt"
                    @keyup.enter="applyStandingPrompt"
                >
                <datalist id="standing-prompt-history">
                    <option v-for="h in history" :key="h" :value="h" />
                </datalist>
                <div class="project-settings__state">
                    <template v-if="standingSaved">
                        Active — every wake starts with this.
                    </template>
                    <template v-else>
                        None. Wakes are unchanged.
                    </template>
                </div>
            </section>

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

            <!-- #1550 — the editable "Project config" section (ManagedConfig) is
                 hidden for now. The layered config service doesn't yet honor all
                 layers coherently (the UI wrote DB overrides that the file-sourced
                 runtime never read), and it's ambiguous under node-proxy where the
                 file layer lives on another machine. Per-project config lives in
                 `.aiball.yaml` until the config-service rework lands. Re-enable by
                 restoring the ManagedConfig section (+ import). -->
        </AsyncState>
    </AdminDashboardLayout>
</template>

<style>
/* Layout (largeur + gouttière + breadcrumb) → `<AdminDashboardLayout>` (#458). */
.project-settings__section {
    padding: 1rem 1.2rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: var(--radius-lg);
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
    font-size: var(--fs-lg);
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
.project-settings__standing-input {
    width: 100%;
    max-width: 42rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--p-inputtext-border-color, var(--p-surface-300));
    border-radius: var(--p-border-radius, 6px);
    background: var(--p-inputtext-background, transparent);
    color: inherit;
    font: inherit;
}
.project-settings__strategy-select {
    min-width: 14rem;
}
.project-settings__strategy-opt small {
    display: block;
    color: var(--p-text-muted-color);
    font-size: var(--fs-sm);
    margin-top: 0.1rem;
}
.project-settings__state {
    font-size: var(--fs-md);
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
        font-size: var(--fs-sm);
    }
    .project-settings__hint {
        font-size: var(--fs-sm);
    }
    .project-settings__strategy-select {
        min-width: 0;
        width: 100%;
    }
    .project-settings__state {
        font-size: var(--fs-sm);
    }
}
</style>

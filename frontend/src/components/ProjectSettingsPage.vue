<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import Select from "primevue/select";
import { api, type Strategy } from "../lib/api";
import { STRATEGY_OPTIONS } from "../lib/labels";

const props = defineProps<{
    project: string;
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
const loading = ref(false);
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

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const r = await api.getProjectStrategy(props.project);
        strategy.value = r.strategy;
        strategyGlobal.value = r.global;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.project, () => load());
onMounted(load);
</script>

<template>
    <div class="project-settings">
        <header class="project-settings__header">
            <!-- #B.161 mobile: back button to return to the inbox.
                 Always rendered; styling makes it tight so it doesn't
                 dominate on desktop either. -->
            <button
                type="button"
                class="project-settings__back"
                title="Back to inbox"
                @click="emit('back')"
            >
                <i class="pi pi-arrow-left" /> back
            </button>
            <h2>{{ project }} — settings</h2>
        </header>

        <div v-if="loading" class="aiball-empty">Loading settings…</div>
        <div v-else-if="error" class="aiball-empty" style="color: var(--p-red-500)">
            {{ error }}
        </div>

        <template v-else>
            <section class="project-settings__section">
                <h3>Moderation strategy</h3>
                <p class="project-settings__hint">
                    Choose how new comments and tickets are moderated in
                    <strong>{{ project }}</strong>. Leave on "Use global" to
                    follow the daemon-wide default; override only when this
                    project needs a different policy.
                </p>
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
        </template>
    </div>
</template>

<style>
.project-settings {
    display: flex;
    flex-direction: column;
    gap: 1rem;
}
.project-settings__header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.project-settings__header h2 {
    margin: 0;
    font-size: 1.3rem;
}
.project-settings__back {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    background: transparent;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    padding: 0.25rem 0.55rem;
    color: var(--p-text-color);
    cursor: pointer;
    font: inherit;
    font-size: 0.85rem;
}
.project-settings__back:hover {
    background: var(--p-surface-100);
}
.project-settings__section {
    padding: 1rem 1.2rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    max-width: 38rem;
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
    .project-settings {
        gap: 0.6rem;
    }
    .project-settings__header h2 {
        font-size: 1.05rem;
    }
    .project-settings__back {
        padding: 0.2rem 0.4rem;
        font-size: 0.78rem;
    }
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

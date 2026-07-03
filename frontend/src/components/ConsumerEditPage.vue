<script setup lang="ts">
/**
 * Dedicated edit page for a single consumer (#B.193 item 3).
 *
 * Rendered by ConsumersPanel when the parent route is /consumers/<id>.
 * Same fields as the inline row editor (kind, display_name, enabled,
 * note) but with more room — and a single save action so all changes
 * land atomically.
 *
 * #460 — also the centralised home for the loop's live status + the
 * Stop button. Other places (ConsumersPanel row, ProjectDetailPage
 * loop chip) link here so the operator has ONE canonical detail view
 * per consumer.
 *
 * Tab contents are extracted: Overview → ConsumerOverview.vue, Edit →
 * ConsumerEditForm.vue. This page keeps the loader (single source of
 * truth for `original`), the tab shell, the lazy Terminal tab and the
 * bus wiring.
 */
import { ref, watch } from "vue";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import { api, type Consumer } from "../lib/api";
import { useLoader } from "../lib/loader";
import AdminDetailLayout from "./ui/AdminDetailLayout.vue";
import AsyncState from "./ui/AsyncState.vue";
import ConsumerEditForm from "./ConsumerEditForm.vue";
import ConsumerOverview from "./ConsumerOverview.vue";
import TerminalView from "./TerminalView.vue";

// #464 — third tab "Terminal" (live tmux/psmux pane mirror) wired in
// below. We model the active tab as a ref so the TerminalView only
// mounts when its tab is selected — keeps the SSE connection lazy so
// just OPENING the consumer detail page doesn't spawn capture-pane
// every 1s for every consumer the operator opens.
const activeTab = ref<"overview" | "edit" | "terminal">("overview");

const props = defineProps<{ consumerId: string }>();
const emit = defineEmits<{
    (e: "close"): void;
    (e: "close-to-inbox"): void;
}>();

const error = ref<string | null>(null);
const original = ref<Consumer | null>(null);

// #472 david `6d56gs` : keep-stale-while-refetching — flipping `loading`
// on a bus refresh unmounted the main subtree (the template chains
// `v-else-if="original"` after `v-if="loading"`) → TerminalView re-mounted
// (fullscreen/SSE/xterm re-created). `showLoading` limits the spinner to
// the FIRST load ; later refreshes keep the rendered UI while the request
// runs (on refresh error the existing content stays, no flash).
const { loading, load } = useLoader(async () => {
    // We reuse the full-list endpoint and filter client-side (cost is
    // small — a few hundred rows max). A per-id GET exists since #397
    // (used by the claude-loop wake builder) but the list already carries
    // `micro_prompt`, so there's no need for a second round-trip here.
    // The tab children (ConsumerOverview / ConsumerEditForm) derive their
    // own state from `original` — no per-field assignment here anymore.
    const all = await api.listConsumers();
    const found = all.find((c) => c.consumer_id === props.consumerId);
    if (!found) throw new Error(`Consumer "${props.consumerId}" not found.`);
    original.value = found;
}, { error, showLoading: () => !original.value, refreshOn: ["consumers.refresh"] });

watch(() => props.consumerId, load, { immediate: true });

// #460 — live updates ride the `consumers.refresh` lane via `refreshOn`
// above (daemon consumer_changed → WS relay → bus) : without it the page
// reads a FROZEN snapshot until manual refresh (cf. ProjectDetailPage #443).
</script>

<template>
    <AdminDetailLayout
        :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Consumers', href: '/consumers' }]"
        :current="props.consumerId"
        title="Edit consumer"
        @close-to-inbox="emit('close-to-inbox')"
        @close-to-list="emit('close')"
    >
        <AsyncState :loading="loading">
            <div v-if="error" class="aiball-empty consumer-edit__error">
                <i class="pi pi-exclamation-triangle" />
                {{ error }}
            </div>
            <!-- #460 — page consumer split en 2 tabs (david `c7tzpk` accepté
                 `w37ybc`) : Overview (show) montre l'identité + loop status +
                 meta ; Edit (form) regroupe les champs éditables + raw prompt
                 + Cancel/Save. Default = Overview (lecture d'abord). En attendant
                 les briques AdminShowLayout/AdminFormLayout du #458 commit 2a,
                 chaque tab garde son markup actuel ; la migration vers les
                 layouts dédiés se fera là-bas. -->
            <template v-else-if="original">
                <Tabs v-model:value="activeTab">
                    <TabList>
                        <Tab value="overview">Overview</Tab>
                        <Tab value="edit">Edit</Tab>
                        <!-- #464 — Terminal tab shown only for agent consumers. Other
                             consumer kinds (human, …) don't have a claude-loop
                             session to mirror. -->
                        <Tab v-if="original.kind === 'agent'" value="terminal">Terminal</Tab>
                    </TabList>
                    <TabPanels>
                        <TabPanel value="overview">
                            <ConsumerOverview
                                :original="original"
                                @close="emit('close')"
                                @refresh="() => void load()"
                            />
                        </TabPanel>

                        <TabPanel value="edit">
                            <ConsumerEditForm
                                :original="original"
                                :consumer-id="props.consumerId"
                                @saved="() => void load()"
                                @close="emit('close')"
                            />
                        </TabPanel>

                        <!-- #464 — Terminal tab : live tmux/psmux pane mirror.
                             Lazy : the TerminalView only mounts when this tab is
                             active, so opening the consumer detail page doesn't
                             open an SSE per consumer the operator browses. -->
                        <TabPanel v-if="original.kind === 'agent'" value="terminal">
                            <div class="consumer-edit__tab">
                                <TerminalView
                                    v-if="activeTab === 'terminal'"
                                    :agent-name="original.consumer_id"
                                    :loop-state="original.state"
                                    :human-present="original.state_human"
                                    :human-word="original.state_human_word"
                                />
                            </div>
                        </TabPanel>
                    </TabPanels>
                </Tabs>
            </template>
        </AsyncState>
    </AdminDetailLayout>
</template>

<style>
/* Layout (largeur + carte) → `<AdminDetailLayout>` (#458). */
/* En-tête (breadcrumb + titre) → bricks internes du layout. */
/* Panel-exclusive rules moved with their markup into ConsumerOverview.vue
   / ConsumerEditForm.vue ; the classes below are shared across tabs, so
   they stay here (non-scoped, like the children). */
/* #460 — chaque tab applique sa gouttière verticale, miroir du body card
   pré-tabs (avant le split Overview/Edit). */
.consumer-edit__tab {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-top: 0.6rem;
}
.consumer-edit__error {
    color: var(--p-red-500);
}
.consumer-edit__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
}
/* consumer_id read-only → <FieldRow> + `.aiball-mono` (style.css). */
</style>

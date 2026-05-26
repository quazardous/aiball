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
 */
import { computed, ref, watch } from "vue";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Tab from "primevue/tab";
import TabList from "primevue/tablist";
import TabPanel from "primevue/tabpanel";
import TabPanels from "primevue/tabpanels";
import Tabs from "primevue/tabs";
import Textarea from "primevue/textarea";
import { useConfirm } from "primevue/useconfirm";
import { api, CONSUMER_KIND_OPTIONS, type Consumer, type ConsumerKind } from "../lib/api";
import { useBus } from "../lib/bus";
import { useNotify } from "../lib/notify";
import { activityClass, presenceClass, presenceWord } from "../lib/consumer-status";
import { relativeTime } from "../lib/format";
import FieldRow from "./ui/FieldRow.vue";
import AdminDetailLayout from "./ui/AdminDetailLayout.vue";
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

const notify = useNotify();
const confirmDialog = useConfirm();
const loading = ref(false);
const saving = ref(false);
const stopBusy = ref(false);
const error = ref<string | null>(null);
const original = ref<Consumer | null>(null);

// #460 — same online/offline criterion as ProjectDetailPage + ConsumersPanel :
// presence-AUTHORITATIVE, with the 120s heartbeat as a bridge for never-seen-
// via-SSE cases (just after a daemon restart). Surface it as a computed so the
// "Loop status" section + the Stop button visibility stay derived.
const ONLINE_MS = 120_000;
const isOnline = computed((): boolean => {
    const c = original.value;
    if (!c) return false;
    if (c.present === true) return true;
    if (c.present === false) return false;
    if (!c.state_updated_at) return false;
    return Date.now() - new Date(c.state_updated_at).getTime() < ONLINE_MS;
});
// Stop is only meaningful when a loop is actually live AND has a `state` (a
// human consumer has no loop to kill).
const canStop = computed((): boolean => !!original.value?.state && isOnline.value);

const kind = ref<ConsumerKind>("agent");
const displayName = ref("");
const note = ref("");
const microPrompt = ref("");
const enabled = ref(true);
// #451: raw-prompt injection (this dedicated page is where the operator types it).
const promptText = ref("");
const promptBusy = ref(false);

const KIND_OPTIONS = CONSUMER_KIND_OPTIONS;

async function load() {
    loading.value = true;
    error.value = null;
    try {
        // We reuse the full-list endpoint and filter client-side (cost is
        // small — a few hundred rows max). A per-id GET exists since #397
        // (used by the claude-loop wake builder) but the list already carries
        // `micro_prompt`, so there's no need for a second round-trip here.
        const all = await api.listConsumers();
        const found = all.find((c) => c.consumer_id === props.consumerId);
        if (!found) {
            error.value = `Consumer "${props.consumerId}" not found.`;
            return;
        }
        original.value = found;
        kind.value = found.kind;
        displayName.value = found.display_name ?? "";
        note.value = found.note ?? "";
        microPrompt.value = found.micro_prompt ?? "";
        enabled.value = found.enabled;
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.consumerId, load, { immediate: true });

// #460 — live updates : the daemon broadcasts `consumer_changed` (presence
// flip / heartbeat) → WS relay → `projects.refresh` bus. Without this, the
// page reads a FROZEN snapshot until manual refresh (cf. ProjectDetailPage
// #443). Re-fetch so the status badges + Stop button reflect reality.
useBus("projects.refresh", () => { void load(); });

async function save() {
    if (!original.value) return;
    saving.value = true;
    try {
        await api.updateConsumer(props.consumerId, {
            kind: kind.value,
            display_name: displayName.value.trim() || null,
            note: note.value.trim() || null,
            micro_prompt: microPrompt.value.trim() || null,
            enabled: enabled.value,
        });
        notify.success(`Saved ${props.consumerId}`);
        emit("close");
    } catch (e) {
        notify.error("Save failed", { detail: (e as Error).message });
    } finally {
        saving.value = false;
    }
}

// #460 — centralised remote hard-kill (mirrors ConsumersPanel + ProjectDetailPage).
// Confirm modal gates it so a stray click never kills a loop. Once #460
// "centralise on the consumer detail" lands fully, the inline shortcuts in the
// list pages can be removed if david wants — left in for now as fast paths.
function stopLoop(): void {
    if (!original.value) return;
    const consumer_id = original.value.consumer_id;
    confirmDialog.require({
        header: "Stop loop",
        message: `Stop the claude-loop running as "${consumer_id}"? This kills its tmux session + Claude (the conversation is lost). Its state is kept — use Delete to remove it entirely.`,
        icon: "pi pi-stop-circle",
        acceptLabel: "Stop",
        rejectLabel: "Cancel",
        acceptClass: "p-button-danger",
        accept: () => { void doStopLoop(consumer_id); },
    });
}
async function doStopLoop(consumer_id: string): Promise<void> {
    stopBusy.value = true;
    try {
        const r = await api.stopLoop(consumer_id);
        if (r.delivered) {
            notify.success(`Stop sent to ${consumer_id}`, { detail: "The loop will self-terminate." });
        } else {
            notify.warn(`No live loop for ${consumer_id}`, { detail: "Nothing was connected to receive it." });
        }
        // Backstop the WS broadcast in case it lags : refresh after a beat.
        setTimeout(() => void load(), 1500);
    } catch (e) {
        notify.error(`Stop failed for ${consumer_id}`, { detail: (e as Error).message });
    } finally {
        stopBusy.value = false;
    }
}

// #451: send a raw, unfiltered prompt to this loop. Spooled then delivered:
// live → injected now; offline → delivered when the loop's SSE reconnects.
async function sendPrompt() {
    const text = promptText.value.trim();
    if (!text) return;
    promptBusy.value = true;
    try {
        const r = await api.sendLoopPrompt(props.consumerId, text);
        if (r.delivered) {
            notify.success(`Prompt sent to ${props.consumerId}`, { detail: "Injected into the live Claude session." });
        } else {
            notify.info(`Prompt spooled for ${props.consumerId}`, { detail: "Loop offline — it'll be delivered when the loop reconnects." });
        }
        promptText.value = "";
    } catch (e) {
        notify.error("Prompt failed", { detail: (e as Error).message });
    } finally {
        promptBusy.value = false;
    }
}
</script>

<template>
    <AdminDetailLayout
        :crumbs="[{ label: 'Inbox', href: '/' }, { label: 'Consumers', href: '/consumers' }]"
        :current="props.consumerId"
        title="Edit consumer"
        @close-to-inbox="emit('close-to-inbox')"
        @close-to-list="emit('close')"
    >
        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty consumer-edit__error">
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
                        <div class="consumer-edit__tab">
                            <FieldRow label="consumer_id">
                                <span class="aiball-mono">{{ original.consumer_id }}</span>
                            </FieldRow>

                            <!-- Loop status + Stop, mêmes chips que
                                 ProjectDetailPage / ConsumersPanel (#460). -->
                            <FieldRow label="loop status">
                                <div class="consumer-edit__status">
                                    <template v-if="original.state">
                                        <template v-if="isOnline">
                                            <span class="ld-tag" :class="activityClass(original.state)">{{ original.state }}</span>
                                            <span
                                                class="ld-tag"
                                                :class="presenceClass(original.state_human, original.state_human_word)"
                                            >{{ presenceWord(original.state_human, original.state_human_word) }}</span>
                                        </template>
                                        <span v-else class="ld-tag ld-tag--offline">offline</span>
                                        <span v-if="original.cwd" class="consumer-edit__cwd" :title="original.cwd">
                                            @ <code>{{ original.cwd }}</code>
                                        </span>
                                        <Button
                                            v-if="canStop"
                                            label="Stop"
                                            icon="pi pi-stop-circle"
                                            severity="danger"
                                            text
                                            size="small"
                                            :loading="stopBusy"
                                            :title="`Stop (hard-kill) the claude-loop running as ${original.consumer_id}`"
                                            @click="stopLoop"
                                        />
                                    </template>
                                    <span v-else class="consumer-edit__status-none">
                                        no loop tracking — this consumer has never reported a state
                                    </span>
                                </div>
                            </FieldRow>

                            <FieldRow label="kind">
                                <span>{{ original.kind }}</span>
                            </FieldRow>
                            <FieldRow v-if="original.display_name" label="display name">
                                <span>{{ original.display_name }}</span>
                            </FieldRow>
                            <FieldRow label="enabled">
                                <span :class="original.enabled ? '' : 'consumer-edit__status-none'">
                                    {{ original.enabled ? "enabled" : "blocked" }}
                                </span>
                            </FieldRow>

                            <div class="consumer-edit__meta">
                                <div><strong>created</strong> {{ original.created_at ? relativeTime(original.created_at) : "—" }}</div>
                                <div><strong>last seen</strong> {{ original.last_seen_at ? relativeTime(original.last_seen_at) : "never" }}</div>
                            </div>
                        </div>
                    </TabPanel>

                    <TabPanel value="edit">
                        <div class="consumer-edit__tab">
                            <div class="consumer-edit__field">
                                <label for="ce-kind">kind</label>
                                <Select
                                    inputId="ce-kind"
                                    v-model="kind"
                                    :options="KIND_OPTIONS"
                                    optionLabel="label"
                                    optionValue="value"
                                    style="width: 100%"
                                />
                            </div>

                            <div class="consumer-edit__field">
                                <label for="ce-name">display name</label>
                                <InputText
                                    id="ce-name"
                                    v-model="displayName"
                                    placeholder="(falls back to consumer_id)"
                                    style="width: 100%"
                                />
                            </div>

                            <div class="consumer-edit__field">
                                <label for="ce-note">note</label>
                                <Textarea
                                    id="ce-note"
                                    v-model="note"
                                    rows="3"
                                    placeholder="(internal note — visible only on this page)"
                                    style="width: 100%"
                                />
                            </div>

                            <div class="consumer-edit__field">
                                <label for="ce-micro-prompt">micro-prompt</label>
                                <Textarea
                                    id="ce-micro-prompt"
                                    v-model="microPrompt"
                                    rows="3"
                                    placeholder="(standing instruction injected into this agent's wake prompt via {consumer_prompt} — e.g. &quot;branch main if the ticket doesn't specify&quot;)"
                                    style="width: 100%"
                                />
                                <small class="consumer-edit__hint">
                                    Surfaced to the agent on wake via the <code>{consumer_prompt}</code>
                                    placeholder. Opt-in: add the placeholder to your <code>wake_master</code>
                                    template (<code>.aiball.yaml</code>) where you want it. Empty = nothing injected.
                                </small>
                            </div>

                            <div class="consumer-edit__field">
                                <label>
                                    <input
                                        type="checkbox"
                                        :checked="enabled"
                                        @change="enabled = ($event.target as HTMLInputElement).checked"
                                    />
                                    enabled (when off, the daemon rejects new posts from this consumer)
                                </label>
                            </div>

                            <!-- #451: raw-prompt injection (moderator-only, server-enforced). -->
                            <div class="consumer-edit__field">
                                <label for="ce-prompt">send a raw prompt</label>
                                <Textarea
                                    id="ce-prompt"
                                    v-model="promptText"
                                    rows="4"
                                    :placeholder="original.present
                                        ? 'Type a prompt — injected verbatim into the live Claude session…'
                                        : 'Loop offline — the prompt will be spooled and delivered when it reconnects.'"
                                    style="width: 100%"
                                    :disabled="promptBusy"
                                    @keydown.ctrl.enter="sendPrompt"
                                />
                                <small class="consumer-edit__hint">
                                    Sent <strong>verbatim</strong> — no moderation, no wake-phrase.
                                    {{ original.present
                                        ? "Loop is live → delivered now."
                                        : "Loop is offline → spooled until it reconnects." }}
                                    Ctrl+Enter to send.
                                </small>
                                <div class="consumer-edit__actions">
                                    <Button
                                        label="Send prompt"
                                        icon="pi pi-send"
                                        size="small"
                                        severity="secondary"
                                        :loading="promptBusy"
                                        :disabled="!promptText.trim()"
                                        @click="sendPrompt"
                                    />
                                </div>
                            </div>

                            <div class="consumer-edit__actions">
                                <Button
                                    label="Cancel"
                                    text
                                    size="small"
                                    :disabled="saving"
                                    @click="emit('close')"
                                />
                                <Button
                                    label="Save"
                                    icon="pi pi-save"
                                    size="small"
                                    :loading="saving"
                                    @click="save"
                                />
                            </div>
                        </div>
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
                            />
                        </div>
                    </TabPanel>
                </TabPanels>
            </Tabs>
        </template>
    </AdminDetailLayout>
</template>

<style>
/* Layout (largeur + carte) → `<AdminDetailLayout>` (#458). */
/* En-tête (breadcrumb + titre) → bricks internes du layout. */
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
.consumer-edit__field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.consumer-edit__field label {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}
.consumer-edit__hint {
    font-size: 0.78rem;
    line-height: 1.35;
    color: var(--p-text-muted-color);
}
.consumer-edit__hint code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.74rem;
}
/* consumer_id read-only → <FieldRow> + `.aiball-mono` (style.css). */
.consumer-edit__meta {
    display: flex;
    gap: 1.5rem;
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
}
.consumer-edit__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
}
/* #460 — loop status row : tags + cwd + Stop button on one line. */
.consumer-edit__status {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
}
.consumer-edit__cwd {
    font-size: 0.78rem;
    color: var(--p-text-muted-color);
}
.consumer-edit__cwd code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.74rem;
}
.consumer-edit__status-none {
    font-size: 0.82rem;
    color: var(--p-text-muted-color);
    font-style: italic;
}
</style>

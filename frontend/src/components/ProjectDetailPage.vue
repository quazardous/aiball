<script setup lang="ts">
// #393 phase 3b: per-project detail page. Shows whether the project is "local"
// (a claude-loop with a known root has run here), its root(s), the loops at
// each root with their live state, and a button to launch a loop for a root.
import { computed, onMounted, ref, watch } from "vue";
import Button from "primevue/button";
import { useToast } from "primevue/usetoast";
import { useConfirm } from "primevue/useconfirm";
import { api, type ProjectMeta, type Consumer } from "../lib/api";
import { useBus } from "../lib/bus";
import AdminDashboardLayout from "./ui/AdminDashboardLayout.vue";

const props = defineProps<{ project: string }>();
const emit = defineEmits<{ (e: "back"): void }>();

const meta = ref<ProjectMeta | null>(null);
const consumers = ref<Consumer[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const launching = ref<string | null>(null);
const flash = ref<string | null>(null);

const toast = useToast();
const confirmDialog = useConfirm();

async function load() {
    loading.value = true;
    error.value = null;
    try {
        const all = await api.listProjectsDetailed();
        meta.value = all.find((p) => p.name === props.project) ?? null;
        consumers.value = await api.listConsumers();
    } catch (e) {
        error.value = (e as Error).message;
    } finally {
        loading.value = false;
    }
}

watch(() => props.project, () => load());
onMounted(load);

// #443: the daemon broadcasts `consumer_changed` whenever a loop's presence
// flips (live SSE open/close, #395) or it heartbeats — the WS relay turns that
// into `projects.refresh` on the bus. Without this subscription the page was a
// FROZEN snapshot: a killed loop kept reading "running" until a manual refresh
// (david's "reste à running assez longtemps"). Refetch so the running badge +
// per-root state + loop chips clear live (~6s after kill, via presence).
useBus("projects.refresh", () => { void load(); });

const roots = computed(() => meta.value?.roots ?? []);

// Loops at each known root (consumer.cwd matches the root).
const loopsByRoot = computed(() => {
    const map = new Map<string, Consumer[]>();
    for (const r of roots.value) map.set(r, []);
    for (const c of consumers.value) {
        if (c.cwd && map.has(c.cwd)) map.get(c.cwd)!.push(c);
    }
    return map;
});

// A loop is "online" — #443: presence-AUTHORITATIVE, mirroring the server's
// `consumerEffectiveRunning`. Live SSE presence (#395) wins (true/false) so a
// killed loop reads offline within the grace (~6s); the 120s heartbeat window
// is only the bridge for a consumer never seen via SSE this session (present
// null — e.g. right after a daemon restart, before loops reconnect).
const ONLINE_MS = 120_000;
function isOnline(c: Consumer): boolean {
    if (c.present === true) return true;
    if (c.present === false) return false;
    if (!c.state_updated_at) return false;
    return Date.now() - new Date(c.state_updated_at).getTime() < ONLINE_MS;
}
// #395 (q3bfvn): render the busy/idle/boot + loop/human state as CSS tags
// (like ConsumersPanel) instead of plain "busy · loop" text. Same colour
// mapping: busy=info/blue, boot=warn/yellow, idle=grey; loop=green, stop=red,
// wait/human=yellow.
function activityClass(state?: string | null): string {
    if (state === "busy") return "ld-tag--busy";
    if (state === "boot") return "ld-tag--boot";
    return "ld-tag--idle";
}
function presenceWord(human?: boolean | null, word?: string | null): string {
    return word ?? (human ? "human" : "loop");
}
function presenceClass(human?: boolean | null, word?: string | null): string {
    const w = presenceWord(human, word);
    if (w === "stop") return "ld-tag--stop";
    // #426: `ask` (ASK-grace) shares the grace-state tint on this coarser web view.
    if (w === "wait" || w === "human" || w === "ask") return "ld-tag--wait";
    return "ld-tag--loop";
}

// #393 (3c): a root is "running" when one of its loops is online → no relaunch.
function rootIsRunning(root: string): boolean {
    return (loopsByRoot.value.get(root) ?? []).some(isOnline);
}

async function launch(root: string) {
    launching.value = root;
    flash.value = null;
    try {
        const r = await api.launchLoop(props.project, root);
        flash.value = `Launched (pid ${r.pid}) at ${root}`;
        setTimeout(load, 1500);
    } catch (e) {
        flash.value = `Launch failed: ${(e as Error).message}`;
    } finally {
        launching.value = null;
    }
}

// #443 (2gx5ev): david wants the remote hard-kill (#442) reachable from the
// per-project page too, not only the Consumers list. Same flow mirrored: a
// PrimeVue ConfirmDialog gates the call so a stray click never kills a loop.
function stopLoop(consumer_id: string) {
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
// The running badge + loop chip clear on their own via the presence WS broadcast
// (`projects.refresh` → load()); reload shortly after as a backstop.
async function doStopLoop(consumer_id: string) {
    try {
        const r = await api.stopLoop(consumer_id);
        toast.add({
            severity: r.delivered ? "success" : "warn",
            summary: r.delivered ? `Stop sent to ${consumer_id}` : `No live loop for ${consumer_id}`,
            detail: r.delivered ? "The loop will self-terminate." : "Nothing was connected to receive it.",
            life: 5000,
        });
        setTimeout(() => void load(), 1500);
    } catch (e) {
        toast.add({
            severity: "error",
            summary: `Stop failed for ${consumer_id}`,
            detail: (e as Error).message,
            life: 6000,
        });
    }
}
</script>

<template>
    <AdminDashboardLayout
        class="project-detail"
        :crumbs="[{ label: 'Inbox', href: '/' }]"
        :current="project"
        title="Detail"
        @close-to-inbox="emit('back')"
    >
            <template #actions>
                <span v-if="meta?.running" class="project-detail__local is-running"><i class="pi pi-desktop" /> running</span>
                <span v-else-if="meta?.local" class="project-detail__local"><i class="pi pi-desktop" /> local</span>
                <!-- #395 (q3bfvn): the running loop's activity + presence as CSS tags. -->
                <template v-if="meta?.running && meta.running_state">
                    <span class="ld-tag" :class="activityClass(meta.running_state)">{{ meta.running_state }}</span>
                    <span class="ld-tag" :class="presenceClass(meta.running_human, meta.running_human_word)">{{ presenceWord(meta.running_human, meta.running_human_word) }}</span>
                </template>
                <button type="button" class="project-detail__refresh" title="Refresh" @click="load">
                    <i class="pi pi-refresh" />
                </button>
            </template>

        <div v-if="loading" class="aiball-empty">Loading…</div>
        <div v-else-if="error" class="aiball-empty" style="color: var(--p-red-500)">{{ error }}</div>

        <template v-else>
            <p v-if="flash" class="project-detail__flash">{{ flash }}</p>

            <div v-if="roots.length === 0" class="aiball-empty">
                No local loop has run for this project. A project becomes <strong>local</strong>
                when a claude-loop runs in its directory (the root is then discovered automatically).
            </div>

            <section v-for="root in roots" :key="root" class="project-detail__root">
                <div class="project-detail__root-head">
                    <code class="project-detail__path">{{ root }}</code>
                    <span v-if="rootIsRunning(root)" class="project-detail__running">
                        <i class="pi pi-circle-fill" /> running
                    </span>
                    <!-- #443 (5dvkqg): harmonised with the per-loop Stop — both are
                         now icon-only PrimeVue Buttons (play/success = start,
                         stop-circle/danger = stop) instead of a classic text button
                         next to an icon one. `loading` swaps the play glyph for a
                         spinner + disables while the launch is in flight. -->
                    <Button
                        v-else
                        class="project-detail__launch"
                        icon="pi pi-play"
                        severity="success"
                        text
                        rounded
                        size="small"
                        :loading="launching === root"
                        :title="launching === root ? 'launching…' : 'Launch a claude-loop for this root'"
                        @click="launch(root)"
                    />
                </div>
                <ul class="project-detail__loops">
                    <li
                        v-for="c in loopsByRoot.get(root) ?? []"
                        :key="c.consumer_id"
                        class="project-detail__loop"
                        :class="{ 'is-offline': !isOnline(c) }"
                    >
                        <span class="project-detail__dot" :class="isOnline(c) ? 'is-on' : 'is-off'" />
                        <span class="project-detail__loop-id">{{ c.consumer_id }}</span>
                        <!-- #395 (q3bfvn): busy/idle + loop/human as CSS tags (was plain text). -->
                        <template v-if="isOnline(c)">
                            <span class="ld-tag" :class="activityClass(c.state)">{{ c.state ?? "?" }}</span>
                            <span class="ld-tag" :class="presenceClass(c.state_human, c.state_human_word)">{{ presenceWord(c.state_human, c.state_human_word) }}</span>
                        </template>
                        <span v-else class="ld-tag ld-tag--offline">offline</span>
                        <!-- #443 (2gx5ev): remote hard-kill on any live loop, mirrors ConsumersPanel. -->
                        <Button
                            v-if="isOnline(c)"
                            class="project-detail__stop"
                            icon="pi pi-stop-circle"
                            severity="danger"
                            text
                            rounded
                            size="small"
                            :title="`Stop (hard-kill) the claude-loop running as ${c.consumer_id}`"
                            @click="stopLoop(c.consumer_id)"
                        />
                    </li>
                    <li v-if="(loopsByRoot.get(root) ?? []).length === 0" class="project-detail__none">
                        no loop registered at this root yet
                    </li>
                </ul>
            </section>
        </template>
    </AdminDashboardLayout>
</template>

<style scoped>
/* Layout (largeur + gouttière + breadcrumb) → `<AdminDashboardLayout>` (#458). */
.project-detail__local {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.78rem;
    font-weight: 600;
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
    border-radius: 999px;
    padding: 0.1rem 0.5rem;
}
.project-detail__local.is-running {
    background: var(--p-green-500, #22c55e);
    color: #fff;
}
/* #395 (q3bfvn): CSS tag for the loop's busy/idle + loop/human state, same
   colour scheme as ConsumersPanel (busy=blue, boot/wait=yellow, idle=grey,
   loop=green, stop=red). */
.ld-tag {
    display: inline-flex;
    align-items: center;
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1;
    border-radius: 999px;
    padding: 0.15rem 0.5rem;
    text-transform: lowercase;
    letter-spacing: 0.02em;
    background: var(--p-surface-200, #e5e7eb);
    color: var(--p-surface-700, #374151);
}
.ld-tag--busy { background: var(--p-blue-500, #3b82f6); color: #fff; }
.ld-tag--boot { background: var(--p-yellow-500, #eab308); color: #1f2937; }
.ld-tag--idle { background: var(--p-surface-300, #d1d5db); color: var(--p-surface-700, #374151); }
.ld-tag--loop { background: var(--p-green-500, #22c55e); color: #fff; }
.ld-tag--wait { background: var(--p-yellow-500, #eab308); color: #1f2937; }
.ld-tag--stop { background: var(--p-red-500, #ef4444); color: #fff; }
.ld-tag--offline { background: transparent; color: var(--p-surface-400, #9ca3af); border: 1px solid var(--p-surface-300, #d1d5db); }
.project-detail__refresh {
    background: transparent;
    border: 0;
    color: var(--p-text-muted-color);
    cursor: pointer;
    padding: 0.3rem 0.5rem;
    border-radius: 0.3rem;
}
.project-detail__refresh:hover { background: var(--p-surface-100); }
.project-detail__flash {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--p-surface-100);
    border-radius: 0.4rem;
    font-size: 0.85rem;
}
.project-detail__root {
    padding: 0.8rem 1rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.5rem;
    background: var(--p-content-background);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
}
.project-detail__root-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
}
.project-detail__path {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85rem;
    color: var(--p-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
}
/* #443 (5dvkqg): now an icon-only PrimeVue Button (see template) — the
   styling is the Button's; we only keep the right-edge push. */
.project-detail__launch {
    margin-left: auto;
}
/* #393 (3c): a loop is live at this root → show status instead of a launch. */
.project-detail__running {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--p-green-600, #16a34a);
    white-space: nowrap;
}
.project-detail__running .pi {
    font-size: 0.6rem;
    animation: project-detail-pulse 2s ease-in-out infinite;
}
@keyframes project-detail-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
.project-detail__loops {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
}
.project-detail__loop {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
}
.project-detail__loop.is-offline { opacity: 0.6; }
/* #443: hard-kill button pushed to the right edge of the loop row. */
.project-detail__stop { margin-left: auto; }
.project-detail__dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    flex: none;
}
.project-detail__dot.is-on { background: var(--p-green-500); }
.project-detail__dot.is-off { background: var(--p-surface-400); }
.project-detail__loop-id {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: var(--p-text-color);
}
.project-detail__loop-state {
    color: var(--p-text-muted-color);
    font-size: 0.8rem;
}
.project-detail__none {
    color: var(--p-text-muted-color);
    font-style: italic;
    font-size: 0.82rem;
}
</style>

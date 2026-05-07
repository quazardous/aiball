<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { api, type Message } from "./lib/api";
import { useWs } from "./lib/ws";
import MessageCard from "./components/MessageCard.vue";
import RulesPanel from "./components/RulesPanel.vue";
import TagsPanel from "./components/TagsPanel.vue";
import TicketList from "./components/TicketList.vue";
import ThreadView from "./components/ThreadView.vue";

const toast = useToast();

type Tab = "tickets" | "pending" | "approved" | "rejected";
const tab = ref<Tab>("tickets");
const tabOptions: { label: string; value: Tab; icon: string }[] = [
    { label: "Tickets", value: "tickets", icon: "pi pi-ticket" },
    { label: "Pending", value: "pending", icon: "pi pi-clock" },
    { label: "Approved", value: "approved", icon: "pi pi-check" },
    { label: "Rejected", value: "rejected", icon: "pi pi-times" },
];

// Per-tab badge counters — incremented on WS push when the user isn't on
// that tab; cleared when the tab becomes active.
const tabBadges = ref<Record<Tab, number>>({
    tickets: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
});

// Sidebar can route to a settings panel that replaces the lists entirely.
type SettingsPanel = "rules" | "tags";
const panel = ref<SettingsPanel | null>(null);

// OS notifications: lazily ask permission on first interaction so we don't
// spam the user with a permission popup at boot.
const notifAllowed = ref(
    typeof Notification !== "undefined" && Notification.permission === "granted",
);
const notifMuted = ref(localStorage.getItem("aiball.notifMuted") === "1");
function toggleMute() {
    notifMuted.value = !notifMuted.value;
    localStorage.setItem("aiball.notifMuted", notifMuted.value ? "1" : "0");
}
async function ensureNotifPermission() {
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "granted") {
        notifAllowed.value = true;
        return true;
    }
    if (Notification.permission === "denied") return false;
    const r = await Notification.requestPermission();
    notifAllowed.value = r === "granted";
    return notifAllowed.value;
}
function fireOsNotif(title: string, body: string) {
    if (notifMuted.value) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (document.hasFocus()) return; // page already visible, toast is enough
    try {
        new Notification(title, { body, tag: "aiball" });
    } catch {
        /* ignore */
    }
}

const projects = ref<string[]>([]);
const project = ref<string | null>(
    localStorage.getItem("aiball.project") || null,
);
const messages = ref<Message[]>([]);
const loading = ref(false);
const dark = ref(localStorage.getItem("aiball.dark") === "1");
const compact = ref(localStorage.getItem("aiball.compact") !== "0");
const openTicketId = ref<number | null>(null);
const ticketListRef = ref<InstanceType<typeof TicketList> | null>(null);
const threadRef = ref<InstanceType<typeof ThreadView> | null>(null);

const selectMode = ref(false);
const selectedIds = ref<Set<number>>(new Set());
const bulkBusy = ref(false);

const isStatusList = computed(
    () => panel.value === null && tab.value !== "tickets",
);

function toggleSelected(id: number, v: boolean) {
    const next = new Set(selectedIds.value);
    if (v) next.add(id);
    else next.delete(id);
    selectedIds.value = next;
}
function clearSelection() {
    selectedIds.value = new Set();
}
function selectAllVisible() {
    selectedIds.value = new Set(messages.value.map((m) => m.id));
}
async function bulkDecide(action: "approve" | "reject") {
    const ids = [...selectedIds.value];
    if (!ids.length) return;
    bulkBusy.value = true;
    let ok = 0;
    let failed = 0;
    try {
        for (const id of ids) {
            try {
                if (action === "approve") await api.approve(id);
                else await api.reject(id);
                ok++;
            } catch {
                failed++;
            }
        }
        toast.add({
            severity: failed ? "warn" : "success",
            summary: `${action}d ${ok} message${ok === 1 ? "" : "s"}`,
            detail: failed ? `${failed} failed` : undefined,
            life: 3500,
        });
        clearSelection();
        await loadMessages();
    } finally {
        bulkBusy.value = false;
    }
}

watch(project, (v) => {
    if (v) localStorage.setItem("aiball.project", v);
    else localStorage.removeItem("aiball.project");
    openTicketId.value = null;
});

watch(dark, (v) => {
    localStorage.setItem("aiball.dark", v ? "1" : "0");
    document.documentElement.classList.toggle("aiball-dark", v);
});
document.documentElement.classList.toggle("aiball-dark", dark.value);

watch(compact, (v) => {
    localStorage.setItem("aiball.compact", v ? "1" : "0");
});
provide("compact", compact);

async function loadProjects() {
    try {
        projects.value = await api.listProjects();
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load projects",
            detail: (e as Error).message,
            life: 4000,
        });
    }
}

async function loadMessages() {
    if (!isStatusList.value) return;
    loading.value = true;
    try {
        messages.value = await api.listMessages({
            status: tab.value,
            project: project.value ?? undefined,
            limit: 200,
        });
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load messages",
            detail: (e as Error).message,
            life: 4000,
        });
    } finally {
        loading.value = false;
    }
}

function refresh() {
    loadProjects();
    if (openTicketId.value !== null) {
        threadRef.value?.load();
    } else if (tab.value === "tickets") {
        ticketListRef.value?.load();
    } else {
        loadMessages();
    }
}

function onMessageChanged(updated: Message) {
    if (!isStatusList.value) {
        if (openTicketId.value !== null) threadRef.value?.load();
        else ticketListRef.value?.load();
        return;
    }
    const idx = messages.value.findIndex((m) => m.id === updated.id);
    if (updated.status === tab.value) {
        if (idx >= 0) messages.value[idx] = updated;
        else messages.value = [updated, ...messages.value];
    } else if (idx >= 0) {
        messages.value.splice(idx, 1);
    }
}

function shortKindLabel(m: Message): string {
    switch (m.kind) {
        case "ticket_created":
            return "ticket";
        case "comment_added":
            return "comment";
        case "ticket_closed":
            return "ticket close";
    }
    return m.kind;
}

function bumpBadge(target: Tab) {
    if (tab.value === target && openTicketId.value === null) return;
    tabBadges.value = { ...tabBadges.value, [target]: tabBadges.value[target] + 1 };
}

function notifyArrival(m: Message) {
    const inScope = !project.value || project.value === m.project;
    if (!inScope) return;

    const who = m.by_agent ?? "unknown";
    const k = shortKindLabel(m);
    const summary =
        m.title ?? (m.body ? m.body.slice(0, 80) : `new ${k}`);
    const detail = `${who} · #${m.id} · ${m.project}`;

    toast.add({
        severity: m.status === "pending" ? "warn" : "info",
        summary: `${k}${m.status === "pending" ? " pending review" : ""}: ${summary}`,
        detail,
        life: 4000,
    });
    fireOsNotif(`aiball — ${k}`, `${summary}\n${detail}`);

    if (m.status === "pending") bumpBadge("pending");
    else if (m.status === "approved") {
        bumpBadge("approved");
        if (m.kind === "ticket_created") bumpBadge("tickets");
    } else if (m.status === "rejected") bumpBadge("rejected");
}

const { connected } = useWs((ev) => {
    if (ev.type === "rule_changed") return;
    const data = ev.data as Message | undefined;
    if (!data || typeof data !== "object") return;

    // Surface every arrival/transition with a toast and (off-tab) OS notif.
    if (ev.type === "message_created" || ev.type === "message_decided") {
        notifyArrival(data);
    }

    // Tickets / Thread view: any creation or decision in the active scope
    // forces a reload so the ticket list, comment count and timestamps stay
    // consistent without manual refresh.
    if (!isStatusList.value) {
        const inScope = !project.value || project.value === data.project;
        if (!inScope) return;
        if (openTicketId.value !== null) {
            const onThisThread =
                data.id === openTicketId.value ||
                data.ticket_id === openTicketId.value;
            if (onThisThread) threadRef.value?.load();
        } else {
            ticketListRef.value?.load();
        }
        return;
    }

    // Pending / Approved / Rejected lists.
    if (ev.type === "message_created") {
        if (
            data.status === tab.value &&
            (!project.value || project.value === data.project)
        ) {
            const idx = messages.value.findIndex((m) => m.id === data.id);
            if (idx < 0) messages.value = [data, ...messages.value];
            else messages.value[idx] = data;
        }
    } else {
        onMessageChanged(data);
    }
});

watch([tab, project], () => {
    if (isStatusList.value) loadMessages();
});

onMounted(() => {
    loadProjects();
    if (isStatusList.value) loadMessages();
});

function selectProject(p: string | null) {
    project.value = p;
    panel.value = null;
    openTicketId.value = null;
}

function openPanel(p: SettingsPanel) {
    panel.value = p;
    openTicketId.value = null;
    clearSelection();
}

function selectTab(v: Tab) {
    tab.value = v;
    openTicketId.value = null;
    tabBadges.value = { ...tabBadges.value, [v]: 0 };
    clearSelection();
}

const projectListItems = computed(() => [
    { label: "All projects", value: null, icon: "pi pi-globe" },
    ...projects.value.map((p) => ({ label: p, value: p, icon: "pi pi-folder" })),
]);
</script>

<template>
    <div class="aiball-shell" :class="{ 'aiball-compact': compact }">
        <header class="aiball-header">
            <h1>aiball</h1>
            <span
                class="connection-dot"
                :class="connected ? 'live' : 'offline'"
                :title="connected ? 'WebSocket live' : 'WebSocket offline'"
            />
            <span class="spacer" />
            <Button
                :icon="compact ? 'pi pi-th-large' : 'pi pi-bars'"
                :title="compact ? 'switch to comfortable view' : 'switch to compact view'"
                severity="secondary"
                text
                rounded
                @click="compact = !compact"
            />
            <Button
                v-if="!notifAllowed && !notifMuted"
                icon="pi pi-bell"
                label="enable alerts"
                size="small"
                severity="secondary"
                text
                @click="ensureNotifPermission"
            />
            <Button
                v-else
                :icon="notifMuted ? 'pi pi-bell-slash' : 'pi pi-bell'"
                :title="notifMuted ? 'OS notifications muted' : 'OS notifications on'"
                severity="secondary"
                text
                rounded
                @click="toggleMute"
            />
            <Button
                :icon="dark ? 'pi pi-sun' : 'pi pi-moon'"
                severity="secondary"
                text
                rounded
                @click="dark = !dark"
            />
            <Button
                icon="pi pi-refresh"
                severity="secondary"
                text
                rounded
                :loading="loading"
                @click="refresh"
            />
        </header>

        <div class="aiball-layout">
            <aside class="aiball-sidebar">
                <div class="sidebar-section-label">Projects</div>
                <button
                    v-for="p in projectListItems"
                    :key="p.value ?? '__all__'"
                    type="button"
                    class="sidebar-item"
                    :class="{ active: panel === null && project === p.value }"
                    @click="selectProject(p.value)"
                >
                    <i :class="p.icon" />
                    <span>{{ p.label }}</span>
                </button>

                <div class="sidebar-section-label" style="margin-top: 1rem">
                    Settings
                </div>
                <button
                    type="button"
                    class="sidebar-item"
                    :class="{ active: panel === 'rules' }"
                    @click="openPanel('rules')"
                >
                    <i class="pi pi-cog" />
                    <span>Rules</span>
                </button>
                <button
                    type="button"
                    class="sidebar-item"
                    :class="{ active: panel === 'tags' }"
                    @click="openPanel('tags')"
                >
                    <i class="pi pi-tag" />
                    <span>Tags</span>
                </button>
            </aside>

            <main class="aiball-main">
                <RulesPanel v-if="panel === 'rules'" />
                <TagsPanel v-else-if="panel === 'tags'" />

                <template v-else>
                    <nav class="aiball-tabs">
                        <button
                            v-for="t in tabOptions"
                            :key="t.value"
                            type="button"
                            class="tab-btn"
                            :class="{ active: tab === t.value }"
                            @click="selectTab(t.value)"
                        >
                            <i :class="t.icon" />
                            <span>{{ t.label }}</span>
                            <span
                                v-if="tabBadges[t.value] > 0 && tab !== t.value"
                                class="tab-badge"
                            >{{ tabBadges[t.value] }}</span>
                        </button>
                    </nav>

                    <ThreadView
                        v-if="openTicketId !== null"
                        ref="threadRef"
                        :ticket-id="openTicketId"
                        @back="openTicketId = null"
                    />

                    <TicketList
                        v-else-if="tab === 'tickets'"
                        ref="ticketListRef"
                        :project="project"
                        @open="(id: number) => (openTicketId = id)"
                    />

                    <template v-else>
                    <div v-if="messages.length" class="bulk-bar">
                        <Button
                            :label="selectMode ? 'cancel select' : 'select'"
                            :icon="selectMode ? 'pi pi-times' : 'pi pi-check-square'"
                            size="small"
                            severity="secondary"
                            text
                            @click="selectMode = !selectMode; clearSelection()"
                        />
                        <template v-if="selectMode">
                            <Button
                                label="all"
                                icon="pi pi-list"
                                size="small"
                                severity="secondary"
                                text
                                @click="selectAllVisible"
                            />
                            <Button
                                label="none"
                                icon="pi pi-minus"
                                size="small"
                                severity="secondary"
                                text
                                :disabled="!selectedIds.size"
                                @click="clearSelection"
                            />
                            <span class="bulk-count">
                                <strong>{{ selectedIds.size }}</strong> selected
                            </span>
                            <span class="spacer" />
                            <template v-if="tab === 'pending'">
                                <Button
                                    label="approve"
                                    icon="pi pi-check"
                                    severity="success"
                                    size="small"
                                    :loading="bulkBusy"
                                    :disabled="!selectedIds.size"
                                    @click="bulkDecide('approve')"
                                />
                                <Button
                                    label="reject"
                                    icon="pi pi-times"
                                    severity="danger"
                                    size="small"
                                    :loading="bulkBusy"
                                    :disabled="!selectedIds.size"
                                    @click="bulkDecide('reject')"
                                />
                            </template>
                        </template>
                    </div>
                    <div v-if="loading && !messages.length" class="aiball-empty">
                        Loading…
                    </div>
                    <div v-else-if="!messages.length" class="aiball-empty">
                        <i class="pi pi-inbox" style="font-size: 1.6rem" />
                        <div>
                            No {{ tab }} messages{{ project ? ` in ${project}` : "" }}.
                        </div>
                    </div>
                    <MessageCard
                        v-for="m in messages"
                        :key="m.id"
                        :message="m"
                        :selectable="selectMode"
                        :selected="selectedIds.has(m.id)"
                        @update:selected="(v: boolean) => toggleSelected(m.id, v)"
                        @changed="onMessageChanged"
                    />
                    </template>
                </template>
            </main>
        </div>

        <Toast />
    </div>
</template>

<style>
.aiball-layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 0;
    flex: 1;
    min-height: 0;
}
.aiball-sidebar {
    border-right: 1px solid var(--p-content-border-color);
    padding: 0.8rem 0.6rem;
    background: var(--p-surface-50);
    overflow-y: auto;
}
.aiball-dark .aiball-sidebar {
    background: var(--p-surface-900);
}
.sidebar-section-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--p-text-muted-color);
    padding: 0.3rem 0.5rem 0.2rem;
}
.sidebar-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 0.45rem 0.6rem;
    border-radius: 0.4rem;
    color: var(--p-text-color);
    cursor: pointer;
    font: inherit;
}
.sidebar-item:hover {
    background: var(--p-surface-100);
}
.aiball-dark .sidebar-item:hover {
    background: var(--p-surface-800);
}
.sidebar-item.active {
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
}
.sidebar-item.active:hover {
    background: var(--p-primary-color);
}

.aiball-main {
    padding: 1rem;
    max-width: 980px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
}

.aiball-tabs {
    display: flex;
    gap: 0.3rem;
    border-bottom: 1px solid var(--p-content-border-color);
    margin-bottom: 0.4rem;
    overflow-x: auto;
}
.tab-btn {
    background: transparent;
    border: 0;
    padding: 0.5rem 0.9rem;
    cursor: pointer;
    font: inherit;
    color: var(--p-text-muted-color);
    border-bottom: 2px solid transparent;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: -1px;
}
.tab-btn:hover {
    color: var(--p-text-color);
}
.tab-btn.active {
    color: var(--p-primary-color);
    border-bottom-color: var(--p-primary-color);
}
.tab-badge {
    background: var(--p-red-500);
    color: white;
    border-radius: 999px;
    padding: 0 0.45rem;
    font-size: 0.72rem;
    font-weight: 600;
    min-width: 1.1rem;
    text-align: center;
    line-height: 1.3rem;
}

.bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--p-content-border-color);
    border-radius: 0.4rem;
    background: var(--p-surface-50);
    position: sticky;
    top: 0;
    z-index: 5;
}
.aiball-dark .bulk-bar { background: var(--p-surface-900); }
.bulk-count {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
}

@media (max-width: 720px) {
    .aiball-layout {
        grid-template-columns: 1fr;
    }
    .aiball-sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--p-content-border-color);
        max-height: 30vh;
    }
}
</style>

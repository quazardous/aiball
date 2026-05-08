<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import Button from "primevue/button";
import Select from "primevue/select";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { api, STRATEGIES, type InboxRow, type Message, type ProjectMeta, type Strategy } from "./lib/api";
import { useRouting } from "./lib/router";
import { useWs } from "./lib/ws";
import ListRow from "./components/ListRow.vue";
import MessageComposer from "./components/MessageComposer.vue";
import ProjectsPanel from "./components/ProjectsPanel.vue";
import RulesPanel from "./components/RulesPanel.vue";
import TagBadge from "./components/TagBadge.vue";
import TagsPanel from "./components/TagsPanel.vue";
import ThreadView from "./components/ThreadView.vue";
import Tag from "primevue/tag";
import Checkbox from "primevue/checkbox";
import ToggleButton from "primevue/togglebutton";

const toast = useToast();

type StatusFilter = "all" | "pending" | "approved" | "rejected";
type IntentFilter = "all" | "panic" | "request" | "question" | "fyi";
type SortBy = "activity" | "created_desc" | "created_asc";

const statusFilter = ref<StatusFilter>(
    (localStorage.getItem("aiball.filter.status") as StatusFilter | null) ?? "pending",
);
const intentFilter = ref<IntentFilter>(
    (localStorage.getItem("aiball.filter.intent") as IntentFilter | null) ?? "all",
);
const onlyOpen = ref(localStorage.getItem("aiball.filter.open") !== "0");
const sortBy = ref<SortBy>(
    (localStorage.getItem("aiball.filter.sort") as SortBy | null) ?? "activity",
);

const statusFilterOptions: { label: string; value: StatusFilter }[] = [
    { label: "All", value: "all" },
    { label: "Pending", value: "pending" },
    { label: "Approved", value: "approved" },
    { label: "Rejected", value: "rejected" },
];
const intentFilterOptions: { label: string; value: IntentFilter }[] = [
    { label: "Any intent", value: "all" },
    { label: "Panic", value: "panic" },
    { label: "Request", value: "request" },
    { label: "Question", value: "question" },
    { label: "FYI", value: "fyi" },
];
const sortOptions: { label: string; value: SortBy }[] = [
    { label: "Recent activity", value: "activity" },
    { label: "Newest first", value: "created_desc" },
    { label: "Oldest first", value: "created_asc" },
];

// Sidebar can route to a settings panel that replaces the lists entirely.
type SettingsPanel = "rules" | "tags" | "projects";
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

const projects = ref<ProjectMeta[]>([]);
const myConsumerId = (() => {
    return localStorage.getItem("aiball.human_id") || "human";
})();
const project = ref<string | null>(
    localStorage.getItem("aiball.project") || null,
);
const rows = ref<InboxRow[]>([]);
const loading = ref(false);
const dark = ref(localStorage.getItem("aiball.dark") === "1");
const compact = ref(localStorage.getItem("aiball.compact") !== "0");
const openTicketId = ref<number | null>(null);
const threadRef = ref<InstanceType<typeof ThreadView> | null>(null);

const selectedIds = ref<Set<number>>(new Set());
const bulkBusy = ref(false);

const composeOpen = ref(false);
function onComposed() {
    composeOpen.value = false;
    refresh();
}

// Auto-refresh: optional 60s heartbeat that triggers a refresh of the
// current view. WS push already keeps things fresh; this is a fallback
// for environments where the WS may have silently dropped.
const autoRefresh = ref(localStorage.getItem("aiball.autoRefresh") === "1");
let autoRefreshTimer: number | null = null;
watch(autoRefresh, (v) => {
    localStorage.setItem("aiball.autoRefresh", v ? "1" : "0");
    if (autoRefreshTimer !== null) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
    if (v) {
        autoRefreshTimer = window.setInterval(() => refresh(), 60_000);
    }
}, { immediate: true });

const strategy = ref<Strategy>("auto-reply");
const strategyOptions: { label: string; value: Strategy; hint: string }[] = [
    {
        label: "Manual approve",
        value: "manual",
        hint: "Every message goes to human review.",
    },
    {
        label: "Auto approve",
        value: "auto",
        hint: "Everything is auto-approved (tickets and replies).",
    },
    {
        label: "Auto approve replies",
        value: "auto-reply",
        hint: "Replies auto-approved; new tickets need human review.",
    },
];
async function loadStrategy() {
    try {
        const r = await api.getStrategy();
        strategy.value = r.strategy;
    } catch {
        /* ignore — daemon may be booting */
    }
}
async function changeStrategy(v: Strategy) {
    const prev = strategy.value;
    strategy.value = v;
    try {
        await api.setStrategy(v);
    } catch (e) {
        strategy.value = prev;
        toast.add({
            severity: "error",
            summary: "Failed to change strategy",
            detail: (e as Error).message,
            life: 8000,
        });
    }
}

const inListView = computed(
    () => panel.value === null && openTicketId.value === null,
);

// Returning to the list view (after closing a panel or a thread) must
// refresh the rows: while the user was in a thread, WS-driven loadRows
// calls bail out (`if (!inListView.value) return`) to avoid wasted HTTP
// when nothing is rendered. This watch picks the rows back up exactly
// once when the list comes back on screen.
watch(inListView, (now, prev) => {
    if (now && !prev) loadRows();
});

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
    selectedIds.value = new Set(rows.value.map((r) => r.id));
}
async function bulkDecide(action: "approve" | "reject") {
    const pendingIds = rows.value
        .filter((r) => selectedIds.value.has(r.id) && r.status === "pending")
        .map((r) => r.id);
    if (!pendingIds.length) return;
    bulkBusy.value = true;
    let ok = 0;
    let failed = 0;
    try {
        for (const id of pendingIds) {
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
            summary: `${action}d ${ok} ticket${ok === 1 ? "" : "s"}`,
            detail: failed ? `${failed} failed` : undefined,
            life: 8000,
        });
        clearSelection();
        await loadRows();
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
        projects.value = await api.listProjectsDetailed(myConsumerId);
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load projects",
            detail: (e as Error).message,
            life: 8000,
        });
    }
}

async function loadRows() {
    if (!inListView.value) return;
    loading.value = true;
    try {
        rows.value = await api.inbox({
            status: statusFilter.value === "all" ? undefined : statusFilter.value,
            intent: intentFilter.value === "all" ? undefined : intentFilter.value,
            project: project.value ?? undefined,
            open: onlyOpen.value,
        });
    } catch (e) {
        toast.add({
            severity: "error",
            summary: "Failed to load inbox",
            detail: (e as Error).message,
            life: 8000,
        });
    } finally {
        loading.value = false;
    }
}

function refresh() {
    loadProjects();
    if (openTicketId.value !== null) threadRef.value?.load();
    else loadRows();
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

function notifyArrival(m: Message) {
    const inScope = !project.value || project.value === m.project;
    if (!inScope) return;

    const who = m.by_agent ?? "unknown";
    const k = shortKindLabel(m);
    const summary = m.title ?? (m.body ? m.body.slice(0, 80) : `new ${k}`);
    // Tickets use their integer id as canonical ref; comments and lifecycle
    // events use the hashid (#C<hashid>) backfilled by the 0003 migration.
    const ref =
        m.kind === "ticket_created"
            ? `#B${m.id}`
            : `#C${m.hashid ?? m.id}`;
    const detail = `${who} · ${ref} · ${m.project}`;

    toast.add({
        severity: m.status === "pending" ? "warn" : "info",
        summary: `${k}${m.status === "pending" ? " pending review" : ""}: ${summary}`,
        detail,
        life: 8000,
    });
    fireOsNotif(`aiball — ${k}`, `${summary}\n${detail}`);
}

const { connected } = useWs((ev) => {
    if (ev.type === "rule_changed") return;
    if (ev.type === "strategy_changed") {
        const s = (ev.data as { strategy?: Strategy } | undefined)?.strategy;
        if (s && (STRATEGIES as readonly string[]).includes(s)) strategy.value = s;
        return;
    }
    if (ev.type === "project_deleted") {
        const deleted = (ev.data as { project?: string } | undefined)?.project;
        // If the user is currently scoped to the just-deleted project, fall
        // back to "all projects" so the lists don't sit empty silently.
        if (deleted && project.value === deleted) project.value = null;
        loadProjects();
        if (inListView.value) loadRows();
        return;
    }
    const data = ev.data as Message | undefined;
    if (!data || typeof data !== "object") return;

    // Surface every arrival/transition with a toast and (off-tab) OS notif.
    if (ev.type === "message_created" || ev.type === "message_decided") {
        notifyArrival(data);
    }

    // Open thread: refresh thread state if the event touches it.
    if (openTicketId.value !== null) {
        const onThisThread =
            data.id === openTicketId.value ||
            data.ticket_id === openTicketId.value;
        if (onThisThread) threadRef.value?.load();
    }

    // Always reload the inbox aggregates too, even when a thread is open.
    // Otherwise lifecycle events fired from inside the thread (close,
    // resolve, broadcast flip) leave the list view stale and the user has
    // to ctrl-r when they navigate back.
    loadRows();
});

watch([statusFilter, intentFilter, onlyOpen, project], () => {
    localStorage.setItem("aiball.filter.status", statusFilter.value);
    localStorage.setItem("aiball.filter.intent", intentFilter.value);
    localStorage.setItem("aiball.filter.open", onlyOpen.value ? "1" : "0");
    if (inListView.value) loadRows();
});

watch(sortBy, (v) => localStorage.setItem("aiball.filter.sort", v));

const sortedRows = computed(() => {
    const r = [...rows.value];
    if (sortBy.value === "created_desc") {
        r.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (sortBy.value === "created_asc") {
        r.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    // "activity" is the API default; rows already arrive sorted that way.
    return r;
});

useRouting({
    panel,
    openTicketId,
    project,
    statusFilter,
    intentFilter,
    onlyOpen,
});

onMounted(() => {
    loadProjects();
    loadStrategy();
    loadRows();
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

function openThread(r: InboxRow) {
    openTicketId.value = r.id;
}

function relativeTime(iso: string): string {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000, hr = 3_600_000, day = 86_400_000;
    if (diff < hr) return `${Math.max(1, Math.floor(diff / min))}m ago`;
    if (diff < day) return `${Math.floor(diff / hr)}h ago`;
    if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
    return d.toLocaleDateString();
}

function snippetOf(r: InboxRow): string {
    const s = r.body ?? "";
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > 140 ? flat.slice(0, 140) + "…" : flat;
}

function titleOf(r: InboxRow): string {
    return r.title ?? "(no title)";
}

function statusSeverity(s: InboxRow["status"]) {
    if (s === "pending") return "warn";
    if (s === "approved") return "success";
    return "danger";
}

function intentSeverity(p: InboxRow["intent"]) {
    if (p === "panic") return "danger";
    if (p === "request") return "info";
    if (p === "question") return "warn";
    return "secondary";
}

const pendingSelectedCount = computed(() =>
    rows.value.filter(
        (r) => selectedIds.value.has(r.id) && r.status === "pending",
    ).length,
);

interface ProjectListItem {
    label: string;
    value: string | null;
    icon: string;
    pending: number;
    unread: number;
}
const projectListItems = computed<ProjectListItem[]>(() => [
    {
        label: "All projects",
        value: null,
        icon: "pi pi-globe",
        pending: projects.value.reduce((acc, p) => acc + (p.pending_count || 0), 0),
        unread: projects.value.reduce((acc, p) => acc + (p.unread_for_consumer || 0), 0),
    },
    ...projects.value.map((p) => ({
        label: p.name,
        value: p.name,
        icon: "pi pi-folder",
        pending: p.pending_count || 0,
        unread: p.unread_for_consumer || 0,
    })),
]);

// Global counts shown in the header (totals across all projects).
const globalPendingCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.pending_count || 0), 0),
);
const globalUnreadCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.unread_for_consumer || 0), 0),
);
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
            <span
                v-if="globalPendingCount > 0"
                class="header-badge header-badge--pending"
                :title="`${globalPendingCount} pending moderation across all projects`"
            >
                <i class="pi pi-clock" /> {{ globalPendingCount }}
            </span>
            <span
                v-if="globalUnreadCount > 0"
                class="header-badge header-badge--unread"
                :title="`${globalUnreadCount} unread for you across all projects`"
            >
                <i class="pi pi-envelope" /> {{ globalUnreadCount }}
            </span>
            <Select
                :model-value="strategy"
                :options="strategyOptions"
                option-label="label"
                option-value="value"
                size="small"
                class="strategy-select"
                :title="strategyOptions.find(o => o.value === strategy)?.hint"
                @update:model-value="(v: Strategy) => changeStrategy(v)"
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
            <Button
                :icon="autoRefresh ? 'pi pi-clock' : 'pi pi-stop-circle'"
                :severity="autoRefresh ? 'success' : 'secondary'"
                :title="autoRefresh ? 'Auto-refresh on (every 60s) — click to stop' : 'Auto-refresh off — click to enable (60s)'"
                text
                rounded
                @click="autoRefresh = !autoRefresh"
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
                    <span class="sidebar-item-label">{{ p.label }}</span>
                    <span
                        v-if="p.pending > 0"
                        class="sidebar-badge sidebar-badge--pending"
                        :title="`${p.pending} pending moderation`"
                    >{{ p.pending }}</span>
                    <span
                        v-if="p.unread > 0"
                        class="sidebar-badge sidebar-badge--unread"
                        :title="`${p.unread} unread for you`"
                    >{{ p.unread }}</span>
                </button>

                <div class="sidebar-section-label" style="margin-top: 1rem">
                    Settings
                </div>
                <button
                    type="button"
                    class="sidebar-item"
                    :class="{ active: panel === 'projects' }"
                    @click="openPanel('projects')"
                >
                    <i class="pi pi-folder" />
                    <span>Projects</span>
                </button>
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
                <ProjectsPanel v-if="panel === 'projects'" />
                <RulesPanel v-else-if="panel === 'rules'" />
                <TagsPanel v-else-if="panel === 'tags'" />

                <ThreadView
                    v-else-if="openTicketId !== null"
                    ref="threadRef"
                    :ticket-id="openTicketId"
                    @back="openTicketId = null"
                />

                <template v-else>
                    <div class="filters-bar">
                        <Select
                            :model-value="statusFilter"
                            :options="statusFilterOptions"
                            option-label="label"
                            option-value="value"
                            size="small"
                            class="filter-select"
                            @update:model-value="(v: StatusFilter) => (statusFilter = v)"
                        />
                        <Select
                            :model-value="intentFilter"
                            :options="intentFilterOptions"
                            option-label="label"
                            option-value="value"
                            size="small"
                            class="filter-select"
                            @update:model-value="(v: IntentFilter) => (intentFilter = v)"
                        />
                        <ToggleButton
                            v-model="onlyOpen"
                            on-label="open only"
                            off-label="all"
                            on-icon="pi pi-folder-open"
                            off-icon="pi pi-folder"
                            size="small"
                        />
                        <Select
                            :model-value="sortBy"
                            :options="sortOptions"
                            option-label="label"
                            option-value="value"
                            size="small"
                            class="filter-select"
                            title="Sort order"
                            @update:model-value="(v: SortBy) => (sortBy = v)"
                        />
                        <span class="spacer" />
                        <Button
                            v-if="!composeOpen"
                            :label="project ? `New ticket in ${project}` : 'New ticket'"
                            icon="pi pi-plus"
                            size="small"
                            :disabled="!project"
                            :title="project ? '' : 'Pick a project first'"
                            @click="composeOpen = true"
                        />
                        <Button
                            v-else
                            label="cancel"
                            icon="pi pi-times"
                            size="small"
                            severity="secondary"
                            text
                            @click="composeOpen = false"
                        />
                    </div>
                    <MessageComposer
                        v-if="composeOpen && project"
                        mode="ticket"
                        :project="project"
                        @submitted="onComposed"
                    />

                    <div v-if="loading && !rows.length" class="aiball-empty">
                        Loading…
                    </div>
                    <div v-else-if="!rows.length" class="aiball-empty">
                        <i class="pi pi-inbox" style="font-size: 1.6rem" />
                        <div>
                            No tickets match your filters{{ project ? ` in ${project}` : "" }}.
                        </div>
                    </div>

                    <ListRow
                        v-for="r in sortedRows"
                        :key="r.id"
                        :selected="selectedIds.has(r.id)"
                        :unread="r.unread"
                        :pending="r.status === 'pending'"
                        :closed="r.closed"
                        :resolution-proposed="r.pending_resolution"
                        :broadcast="r.broadcast"
                        @click="openThread(r)"
                    >
                        <template #select>
                            <Checkbox
                                :model-value="selectedIds.has(r.id)"
                                binary
                                @update:model-value="(v: boolean) => toggleSelected(r.id, v)"
                            />
                        </template>
                        <template #lead>
                            <i
                                v-if="r.closed && r.resolved"
                                class="pi pi-check-circle"
                                title="closed (resolved)"
                                style="color: var(--p-green-500)"
                            />
                            <i
                                v-else-if="r.closed"
                                class="pi pi-lock"
                                title="closed without explicit resolution"
                                style="color: var(--p-orange-500)"
                            />
                            <i
                                v-else-if="r.resolved"
                                class="pi pi-check-circle"
                                title="resolved (pending close)"
                                style="color: var(--p-green-500)"
                            />
                            <i
                                v-else
                                class="pi pi-ticket"
                                style="color: var(--p-text-muted-color)"
                            />
                        </template>
                        <template v-if="r.by_agent" #from>{{ r.by_agent }}</template>
                        <template #title>
                            <span class="ticket-id">#B{{ r.id }}</span>
                            {{ titleOf(r) }}
                            <Tag
                                v-if="r.status !== 'approved'"
                                :value="r.status"
                                :severity="statusSeverity(r.status)"
                                style="margin-left: 0.4rem; font-size: 0.7rem"
                            />
                            <Tag
                                v-if="r.intent"
                                :value="r.intent"
                                :severity="intentSeverity(r.intent)"
                                style="margin-left: 0.3rem; font-size: 0.7rem"
                            />
                            <TagBadge
                                v-for="tg in r.tags"
                                :key="tg.id"
                                :tag="tg"
                                size="sm"
                                style="margin-left: 0.3rem"
                            />
                            <Tag
                                v-if="!project"
                                :value="r.project"
                                severity="info"
                                style="margin-left: 0.4rem; font-size: 0.7rem"
                            />
                        </template>
                        <template v-if="snippetOf(r)" #snippet>{{ snippetOf(r) }}</template>
                        <template #meta>
                            <span v-if="r.pending_comment_count > 0" :title="`${r.pending_comment_count} pending comment${r.pending_comment_count > 1 ? 's' : ''}`">
                                <i class="pi pi-clock" /> {{ r.pending_comment_count }}
                            </span>
                            <span v-else-if="r.comment_count > 0">
                                <i class="pi pi-comments" /> {{ r.comment_count }}
                            </span>
                        </template>
                        <template #time>{{ relativeTime(r.last_activity) }}</template>
                    </ListRow>

                    <div v-if="rows.length" class="bulk-bar bulk-bar--bottom">
                        <Button
                            :label="selectedIds.size ? 'clear' : 'select all'"
                            :icon="selectedIds.size ? 'pi pi-minus' : 'pi pi-list'"
                            size="small"
                            severity="secondary"
                            text
                            @click="selectedIds.size ? clearSelection() : selectAllVisible()"
                        />
                        <span class="bulk-count" v-if="selectedIds.size">
                            <strong>{{ selectedIds.size }}</strong> selected
                        </span>
                        <span class="spacer" />
                        <Button
                            label="approve"
                            icon="pi pi-check"
                            severity="success"
                            size="small"
                            :loading="bulkBusy"
                            :disabled="!pendingSelectedCount"
                            :title="pendingSelectedCount ? '' : 'Select pending tickets to approve'"
                            @click="bulkDecide('approve')"
                        />
                        <Button
                            label="reject"
                            icon="pi pi-times"
                            severity="danger"
                            size="small"
                            :loading="bulkBusy"
                            :disabled="!pendingSelectedCount"
                            :title="pendingSelectedCount ? '' : 'Select pending tickets to reject'"
                            @click="bulkDecide('reject')"
                        />
                    </div>
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
.sidebar-item-label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.sidebar-badge {
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    line-height: 1.2;
}
.sidebar-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.sidebar-badge--unread {
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
}
.sidebar-item.active .sidebar-badge--unread {
    background: var(--p-primary-contrast-color);
    color: var(--p-primary-color);
}
.header-badge {
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.15rem 0.5rem;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
}
.header-badge--pending {
    background: var(--p-yellow-500);
    color: black;
}
.header-badge--unread {
    background: var(--p-primary-color);
    color: var(--p-primary-contrast-color);
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

.filters-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--p-content-border-color);
    margin-bottom: 0.4rem;
}
.filter-select {
    min-width: 9rem;
}
.ticket-id {
    color: var(--p-text-muted-color);
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.85em;
    margin-right: 0.4rem;
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
.bulk-bar--bottom {
    position: sticky;
    top: auto;
    bottom: 0;
    margin-top: 0.4rem;
}
.compose-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0;
}
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

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import Toast from "primevue/toast";
import { useToast } from "primevue/usetoast";
import { api, STRATEGIES, type InboxRow, type Message, type ProjectMeta, type Strategy } from "./lib/api";
import { useRouting } from "./lib/router";
import { useWs } from "./lib/ws";
import { bus, useBus } from "./lib/bus";
import { isPeek } from "./lib/peek";
import BulkBar from "./components/BulkBar.vue";
import { type BulkAction, canDo } from "./lib/ticket-actions";
import {
    STATUS_FILTER_OPTIONS,
    SORT_OPTIONS,
    STRATEGY_OPTIONS,
    type SortBy,
    type StatusFilter,
} from "./lib/labels";
import HeaderBar from "./components/HeaderBar.vue";
import InboxList from "./components/InboxList.vue";
import InboxToolbar from "./components/InboxToolbar.vue";
import NewTicketPage from "./components/NewTicketPage.vue";
import ProjectsPanel from "./components/ProjectsPanel.vue";
import RulesPanel from "./components/RulesPanel.vue";
import Sidebar, { type ProjectListItem, type SettingsPanel } from "./components/Sidebar.vue";
import TagsPanel from "./components/TagsPanel.vue";
import ThreadView from "./components/ThreadView.vue";

const toast = useToast();

// StatusFilter + SortBy types exported from components/InboxToolbar.vue.

const statusFilter = ref<StatusFilter>(
    (localStorage.getItem("aiball.filter.status") as StatusFilter | null) ?? "pending",
);
const onlyOpen = ref(localStorage.getItem("aiball.filter.open") !== "0");
/** Show snoozed tickets in the open inbox (per #B.329). Off by default
 *  so the open inbox stays focused; the header toggle flips it on when
 *  the moderator wants to see what's currently set aside. Counters
 *  (sidebar + header badges) merge open_count + snoozed_count when on. */
const showSnoozed = ref(localStorage.getItem("aiball.show_snoozed") === "1");
const sortBy = ref<SortBy>(
    (localStorage.getItem("aiball.filter.sort") as SortBy | null) ?? "activity",
);
// FTS5 search input. Empty → inbox mode. Debounced before triggering the
// search endpoint so we don't fire a request on every keystroke.
const searchQuery = ref("");
const searchHits = ref<import("./lib/api").SearchHit[]>([]);
const searchActive = computed(() => searchQuery.value.trim().length > 0);

// Option catalogs come from lib/labels.ts — referenced via short
// aliases here so the template stays terse.
const statusFilterOptions = STATUS_FILTER_OPTIONS;
const sortOptions = SORT_OPTIONS;
const strategyOptions = STRATEGY_OPTIONS;

// Sidebar can route to a settings panel that replaces the lists entirely.
// SettingsPanel type lives in components/Sidebar.vue.
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
const openTicketId = ref<number | null>(null);

const selectedIds = ref<Set<number>>(new Set());
const bulkBusy = ref(false);

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
const BULK_LABELS: Record<BulkAction, string> = {
    approve: "approve",
    reject: "reject",
    close: "close",
    reopen: "reopen",
    mark_read: "mark read",
    mark_unread: "mark unread",
    snooze: "snooze",
    unsnooze: "unsnooze",
};

/** Default snooze duration when the bulk button is clicked without a
 *  picker — matches the "+3d" preset of the thread popover. */
const BULK_SNOOZE_DEFAULT_MS = 3 * 86_400_000;

/**
 * Per-row applicability test for each bulk action. Rows that don't
 * pass are silently skipped (no API call, no error), per #B.327: a
 * bulk action should never refuse the whole batch because some rows
 * weren't eligible — it just acts on the ones it can.
 */
async function bulkAction(action: BulkAction) {
    const selected = rows.value.filter((r) => selectedIds.value.has(r.id));
    if (!selected.length) return;
    bulkBusy.value = true;
    let ok = 0, skipped = 0, failed = 0;
    try {
        for (const r of selected) {
            if (!canDo(action, r)) {
                skipped++;
                continue;
            }
            try {
                switch (action) {
                    case "approve":
                        await api.approve(r.id);
                        break;
                    case "reject":
                        await api.reject(r.id);
                        break;
                    case "close":
                        await api.postMessage({
                            project: r.project,
                            kind: "ticket_closed",
                            ticket_id: r.id,
                            parent_id: r.id,
                        });
                        break;
                    case "reopen":
                        await api.postMessage({
                            project: r.project,
                            kind: "ticket_reopened",
                            ticket_id: r.id,
                            parent_id: r.id,
                        });
                        break;
                    case "mark_read":
                        await api.markTicketRead(r.id);
                        break;
                    case "mark_unread":
                        await api.markTicketUnread(r.id);
                        break;
                    case "snooze":
                        await api.postponeTicket(
                            r.id,
                            new Date(Date.now() + BULK_SNOOZE_DEFAULT_MS).toISOString(),
                        );
                        break;
                    case "unsnooze":
                        await api.unsnoozeTicket(r.id);
                        break;
                }
                ok++;
            } catch {
                failed++;
            }
        }
        const label = BULK_LABELS[action];
        let detail = "";
        if (skipped) detail += `${skipped} skipped (not applicable)`;
        if (failed) detail += `${detail ? ", " : ""}${failed} failed`;
        toast.add({
            severity: failed ? "warn" : "success",
            summary: `${label}: ${ok} ticket${ok === 1 ? "" : "s"}`,
            detail: detail || undefined,
            life: 6000,
        });
        clearSelection();
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
    } finally {
        bulkBusy.value = false;
    }
}

/** Count how many selected rows would actually be touched by `action`.
 *  Used to disable the bulk button when no row is eligible. */
function bulkApplicableCount(action: BulkAction): number {
    let n = 0;
    for (const r of rows.value) {
        if (selectedIds.value.has(r.id) && canDo(action, r)) n++;
    }
    return n;
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

// Compact layout is now the only layout (#B.312 ripped out the toggle).
// Clean up the persisted preference so the localStorage stays tidy.
// Keep the provide() so consumers (MessageCard, future opt-in compact
// users) still see a reactive ref — it just never flips anymore.
localStorage.removeItem("aiball.compact");
const compact = ref(true);
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
        if (searchActive.value) {
            // Search mode — hit /api/search and feed the same list slot.
            // Other filters (project, intent, open) compose naturally.
            searchHits.value = await api.search({
                q: searchQuery.value.trim(),
                project: project.value ?? undefined,
                open: onlyOpen.value,
                limit: 100,
            });
            rows.value = []; // we render searchHits in this mode
            return;
        }
        searchHits.value = [];
        // `unread` is a per-consumer view, not a server-side moderation
        // status. Don't forward it to the API — fetch the full set under
        // the other filters, then narrow on the row's `unread` flag
        // client-side. Same payload, smaller pile.
        const apiStatus =
            statusFilter.value === "all" || statusFilter.value === "unread"
                ? undefined
                : statusFilter.value;
        let fetched = await api.inbox({
            status: apiStatus,
            project: project.value ?? undefined,
            open: onlyOpen.value,
            include_postponed: showSnoozed.value,
        });
        if (statusFilter.value === "unread") {
            fetched = fetched.filter((r) => r.unread);
        }
        rows.value = fetched;
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
    // Hard manual refresh (toolbar button + 60s heartbeat fallback for
    // WS-less envs). Route through the bus so consumers stay in sync.
    bus.emit("projects.refresh");
    if (openTicketId.value !== null) {
        bus.emit("thread.refresh", { ticketId: openTicketId.value });
    } else {
        bus.emit("inbox.refresh");
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
            ? `#B.${m.id}`
            : `#C.${m.hashid ?? m.id}`;
    const detail = `${who} · ${ref} · ${m.project}`;

    toast.add({
        severity: m.status === "pending" ? "warn" : "info",
        summary: `${k}${m.status === "pending" ? " pending review" : ""}: ${summary}`,
        detail,
        life: 8000,
    });
    fireOsNotif(`aiball — ${k}`, `${summary}\n${detail}`);
}

// WS handler is now a thin relay: turn WebSocket events into high-level
// `bus` events. Consumers (this file's own list/sidebar/toaster, plus any
// future component) subscribe to the bus where they're defined. See
// `lib/bus.ts` for the typed event map.
const { connected } = useWs((ev) => {
    if (ev.type === "rule_changed") {
        bus.emit("rules.refresh");
        return;
    }
    if (ev.type === "tag_changed") {
        // Tag catalog touched (rename, color, delete) — refresh the
        // tags panel and any open TagPicker. Don't touch inbox/projects
        // here: the catalog change doesn't move per-project counts.
        bus.emit("tags.refresh");
        return;
    }
    if (ev.type === "message_tagged") {
        // A message gained/lost tags. The catalog itself is unchanged,
        // but the open thread (if it contains this message) and the
        // inbox row need to redraw their tag chips. The server sends
        // `{ message_id, tags }` — no ticket_id — so we trigger a
        // defensive thread.refresh on whatever's currently open, plus
        // an inbox refresh. Cheap and self-correcting.
        const tagged = ev.data as { message_id?: number; ticket_id?: number } | undefined;
        if (tagged?.ticket_id !== undefined) {
            bus.emit("thread.refresh", { ticketId: tagged.ticket_id });
        } else if (openTicketId.value !== null) {
            bus.emit("thread.refresh", { ticketId: openTicketId.value });
        }
        bus.emit("inbox.refresh");
        return;
    }
    if (ev.type === "strategy_changed") {
        const s = (ev.data as { strategy?: Strategy } | undefined)?.strategy;
        if (s && (STRATEGIES as readonly string[]).includes(s)) strategy.value = s;
        return;
    }
    if (ev.type === "project_deleted") {
        const deleted = (ev.data as { project?: string } | undefined)?.project;
        if (deleted) bus.emit("project.deleted", { project: deleted });
        bus.emit("projects.refresh");
        bus.emit("inbox.refresh");
        return;
    }
    // Remaining events are message-shaped (`message_created`,
    // `message_decided`, `message_edited`, `message_noted`).
    const data = ev.data as Message | undefined;
    if (!data || typeof data !== "object") return;
    if (ev.type === "message_created") bus.emit("message.arrived", data);
    else if (ev.type === "message_decided") bus.emit("message.decided", data);
    if (data.ticket_id !== null && data.ticket_id !== undefined) {
        bus.emit("thread.refresh", { ticketId: data.ticket_id });
    }
    if (data.kind === "ticket_created") {
        bus.emit("thread.refresh", { ticketId: data.id });
    }
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
});

// Local consumers — same effects as before, just driven by the bus now.
useBus("projects.refresh", () => { loadProjects(); });
useBus("inbox.refresh", () => { loadRows(); });
useBus("message.arrived", (m) => { notifyArrival(m); });
useBus("message.decided", (m) => { notifyArrival(m); });
useBus("project.deleted", ({ project: deleted }) => {
    // If the user is currently scoped to the just-deleted project, fall
    // back to "all projects" so the lists don't sit empty silently.
    if (project.value === deleted) project.value = null;
});
// `thread.refresh` is handled inside ThreadView itself (it knows its own
// ticket id and reloads when the bus event matches), so we don't need to
// poke it through a ref from here.

watch([statusFilter, onlyOpen, project], () => {
    localStorage.setItem("aiball.filter.status", statusFilter.value);
    localStorage.setItem("aiball.filter.open", onlyOpen.value ? "1" : "0");
    if (inListView.value) loadRows();
});
// Legacy intent filter removed (#B.300). Clean up the localStorage key
// so it doesn't linger after the upgrade.
localStorage.removeItem("aiball.filter.intent");

watch(sortBy, (v) => localStorage.setItem("aiball.filter.sort", v));

// Debounce the search input so we don't fire a request on every keystroke
// — 220ms gives a comfortable feel without showing stale results too long.
let searchTimer: number | null = null;
watch(searchQuery, () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
        searchTimer = null;
        if (inListView.value) loadRows();
    }, 220);
});

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

/** Open a search hit — route to the parent thread (with focus when a comment was matched). */
function openSearchHit(hit: import("./lib/api").SearchHit) {
    openTicketId.value = hit.ticket_id;
}

/**
 * Flip the read/unread state on a single row. Optimistic local update so
 * the button feels instant; the next WS event will reconcile if the
 * server end-up disagreed. Permanent control per #C92 — always visible,
 * not hover-only, since acknowledging an unread row by reading-elsewhere
 * is a frequent need.
 */
async function toggleRead(r: InboxRow) {
    if (isPeek()) {
        // Peek mode → don't touch the endorsed agent's seen-state.
        // We still flip the local row so the UI gives feedback, but
        // no API call goes out and the next inbox refresh will
        // reconcile from the server.
        r.unread = !r.unread;
        return;
    }
    const wasUnread = r.unread === true;
    r.unread = !wasUnread;
    try {
        if (wasUnread) await api.markTicketRead(r.id);
        else await api.markTicketUnread(r.id);
        // Read state is per-consumer (no WS broadcast). Push it onto the
        // bus so the sidebar's unread badge follows without a manual
        // refetch, and any future consumer (e.g. an unread indicator on
        // an open thread) can react.
        bus.emit("read-state.changed", {
            ticket_id: r.id,
            consumer_id: localStorage.getItem("aiball.human_id") ?? "human",
            unread: !wasUnread,
        });
        bus.emit("projects.refresh");
    } catch (e) {
        r.unread = wasUnread; // rollback
        toast.add({
            severity: "error",
            summary: "Failed to update read state",
            detail: (e as Error).message,
            life: 5000,
        });
    }
}

const bulkCounts = computed(() => ({
    approve: bulkApplicableCount("approve"),
    reject: bulkApplicableCount("reject"),
    close: bulkApplicableCount("close"),
    reopen: bulkApplicableCount("reopen"),
    mark_read: bulkApplicableCount("mark_read"),
    mark_unread: bulkApplicableCount("mark_unread"),
    snooze: bulkApplicableCount("snooze"),
    unsnooze: bulkApplicableCount("unsnooze"),
}));

/** When the user toggled "show snoozed" on, the open count includes
 *  snoozed tickets (they reappear in the lists and badges). Off by
 *  default — snoozed rows are hidden the same way closed ones are. */
function projectOpenCount(p: ProjectMeta): number {
    const open = p.open_count || 0;
    const snoozed = p.snoozed_count || 0;
    return showSnoozed.value ? open + snoozed : open;
}
const projectListItems = computed<ProjectListItem[]>(() => [
    {
        label: "All projects",
        value: null,
        icon: "pi pi-globe",
        pending: projects.value.reduce((acc, p) => acc + (p.pending_count || 0), 0),
        unread: projects.value.reduce((acc, p) => acc + (p.unread_for_consumer || 0), 0),
        open: projects.value.reduce((acc, p) => acc + projectOpenCount(p), 0),
        resolved: projects.value.reduce((acc, p) => acc + (p.resolved_count || 0), 0),
        snoozed: projects.value.reduce((acc, p) => acc + (p.snoozed_count || 0), 0),
    },
    ...projects.value.map((p) => ({
        label: p.name,
        value: p.name,
        icon: "pi pi-folder",
        pending: p.pending_count || 0,
        unread: p.unread_for_consumer || 0,
        open: projectOpenCount(p),
        resolved: p.resolved_count || 0,
        snoozed: p.snoozed_count || 0,
    })),
]);

// Global counts shown in the header (totals across all projects).
const globalPendingCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.pending_count || 0), 0),
);
const globalUnreadCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.unread_for_consumer || 0), 0),
);
const globalResolvedCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.resolved_count || 0), 0),
);
const globalSnoozedCount = computed(() =>
    projects.value.reduce((acc, p) => acc + (p.snoozed_count || 0), 0),
);

// Persist the toggle + refresh lists so the new include_postponed
// flag takes effect immediately.
watch(showSnoozed, (v) => {
    if (v) localStorage.setItem("aiball.show_snoozed", "1");
    else localStorage.removeItem("aiball.show_snoozed");
    bus.emit("inbox.refresh");
    bus.emit("projects.refresh");
});
</script>

<template>
    <div class="aiball-shell aiball-compact">
        <HeaderBar
            :connected="connected"
            :global-pending-count="globalPendingCount"
            :global-resolved-count="globalResolvedCount"
            :global-unread-count="globalUnreadCount"
            :global-snoozed-count="globalSnoozedCount"
            :show-snoozed="showSnoozed"
            :strategy="strategy"
            :strategy-options="strategyOptions"
            :notif-allowed="notifAllowed"
            :notif-muted="notifMuted"
            :dark="dark"
            :loading="loading"
            :auto-refresh="autoRefresh"
            @update:show-snoozed="showSnoozed = $event"
            @update:strategy="changeStrategy"
            @update:dark="dark = $event"
            @update:auto-refresh="autoRefresh = $event"
            @enable-notif="ensureNotifPermission"
            @toggle-mute="toggleMute"
            @refresh="refresh"
        />

        <div class="aiball-layout">
            <Sidebar
                :items="projectListItems"
                :panel="panel"
                :project="project"
                @select="selectProject"
                @open-panel="openPanel"
            />

            <main class="aiball-main">
                <ProjectsPanel v-if="panel === 'projects'" />
                <RulesPanel v-else-if="panel === 'rules'" />
                <TagsPanel v-else-if="panel === 'tags'" />

                <NewTicketPage
                    v-else-if="panel === 'compose'"
                    :initial-project="project"
                    @back="panel = null"
                    @submitted="panel = null"
                />

                <ThreadView
                    v-else-if="openTicketId !== null"
                    :ticket-id="openTicketId"
                    @back="openTicketId = null"
                />

                <template v-else>
                    <InboxToolbar
                        :status-filter="statusFilter"
                        :status-filter-options="statusFilterOptions"
                        :only-open="onlyOpen"
                        :sort-by="sortBy"
                        :sort-options="sortOptions"
                        :search-query="searchQuery"
                        @update:status-filter="statusFilter = $event"
                        @update:only-open="onlyOpen = $event"
                        @update:sort-by="sortBy = $event"
                        @update:search-query="searchQuery = $event"
                        @new-ticket="panel = 'compose'"
                    />

                    <InboxList
                        :loading="loading"
                        :rows="sortedRows"
                        :project="project"
                        :selected-ids="selectedIds"
                        :search-active="searchActive"
                        :search-hits="searchHits"
                        :search-query="searchQuery"
                        @open-row="openThread"
                        @open-hit="openSearchHit"
                        @toggle-read="toggleRead"
                        @toggle-selected="toggleSelected"
                    />

                    <BulkBar
                        v-if="rows.length"
                        :selected-size="selectedIds.size"
                        :counts="bulkCounts"
                        :busy="bulkBusy"
                        @clear="clearSelection"
                        @select-all="selectAllVisible"
                        @action="bulkAction"
                    />
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
    background: var(--p-blue-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--unread {
    background: white;
    color: var(--p-blue-500);
}
.sidebar-badge--resolved {
    background: var(--p-green-500);
    color: white;
}
.sidebar-item.active .sidebar-badge--resolved {
    background: white;
    color: var(--p-green-500);
}
.sidebar-badge--open {
    background: var(--p-surface-300);
    color: var(--p-text-color);
}
.aiball-dark .sidebar-badge--open {
    background: var(--p-surface-600);
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
    background: var(--p-blue-500);
    color: white;
}
.header-badge--resolved {
    background: var(--p-green-500);
    color: white;
}
.header-badge--snoozed {
    /* Clickable toggle — off = muted indigo (just a count), on = solid
     * indigo (active state, snoozed rows are surfaced everywhere). */
    background: color-mix(in srgb, var(--p-indigo-500) 25%, transparent);
    color: var(--p-indigo-700);
    border: 1px solid color-mix(in srgb, var(--p-indigo-500) 40%, transparent);
    cursor: pointer;
    font-family: inherit;
}
.header-badge--snoozed:hover {
    background: color-mix(in srgb, var(--p-indigo-500) 35%, transparent);
}
.header-badge--snoozed.header-badge--snoozed-on {
    background: var(--p-indigo-500);
    color: white;
    border-color: var(--p-indigo-500);
}
.aiball-dark .header-badge--snoozed {
    color: var(--p-indigo-200);
}
.aiball-dark .header-badge--snoozed.header-badge--snoozed-on {
    color: white;
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
.filter-search {
    min-width: 12rem;
}
.search-hit {
    display: block;
    text-decoration: none;
    color: inherit;
    padding: 0.5rem 0.7rem;
    border-bottom: 1px solid var(--p-content-border-color);
    cursor: pointer;
    transition: background 0.1s;
}
.search-hit:hover {
    background: var(--p-surface-100);
}
.aiball-dark .search-hit:hover {
    background: var(--p-surface-800);
}
.search-hit__head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.9rem;
}
.search-hit__title {
    font-weight: 600;
    color: var(--p-text-color);
}
.search-hit__by {
    font-size: 0.8rem;
    color: var(--p-text-muted-color);
}
.search-hit__snippet {
    font-size: 0.85rem;
    color: var(--p-text-muted-color);
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
}
.search-hit__snippet mark {
    background: color-mix(in srgb, var(--p-yellow-500) 30%, transparent);
    color: var(--p-text-color);
    padding: 0 0.1rem;
    border-radius: 2px;
}
.read-toggle-lead {
    appearance: none;
    background: transparent;
    border: none;
    padding: 0.1rem;
    margin-right: 0.1rem;
    cursor: pointer;
    /* Read state by default → grey. Click toggles via toggleRead(). */
    color: var(--p-text-muted-color);
    transition: color 0.12s, transform 0.08s;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.read-toggle-lead:hover {
    transform: scale(1.1);
}
.read-toggle-lead--unread {
    /* Unread → green so the eye lands on the row from a distance. */
    color: var(--p-green-500);
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

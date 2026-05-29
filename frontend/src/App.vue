<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from "vue";
import Toast from "primevue/toast";
import ConfirmDialog from "primevue/confirmdialog";
import { useToast } from "primevue/usetoast";
import { api, type InboxRow, type ProjectMeta, type Strategy } from "./lib/api";
import { useNotifications } from "./lib/notifications";
import { useRouting } from "./lib/router";
import { useInboxWs } from "./lib/inbox-ws";
import { bus, useBus } from "./lib/bus";
import BulkBar from "./components/BulkBar.vue";
import { type BulkAction, useBulkActions } from "./lib/ticket-actions";
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
import PaginationBar from "./components/PaginationBar.vue";
import NewTicketPage from "./components/NewTicketPage.vue";
import ProjectStatsPage from "./components/ProjectStatsPage.vue";
import ProjectSettingsPage from "./components/ProjectSettingsPage.vue";
import ProjectDetailPage from "./components/ProjectDetailPage.vue";
import ProjectOverviewPage from "./components/ProjectOverviewPage.vue";
import ProjectsPanel from "./components/ProjectsPanel.vue";
import ConsumersPanel from "./components/ConsumersPanel.vue";
import NodesPanel from "./components/NodesPanel.vue";
import LaunchersPanel from "./components/LaunchersPanel.vue";
import GeneralSettingsPanel from "./components/GeneralSettingsPanel.vue";
import AutomationPanel from "./components/AutomationPanel.vue";
import SetupScreen from "./components/SetupScreen.vue";
import LoginScreen from "./components/LoginScreen.vue";
import { setUnauthorizedHandler } from "./lib/api";
import Sidebar, { type ProjectListItem, type ProjectPage, type SettingsPanel } from "./components/Sidebar.vue";
import TagsPanel from "./components/TagsPanel.vue";
import ThreadView from "./components/ThreadView.vue";

const toast = useToast();

// Auth gate (#B.94). Decides whether we render the app shell, the setup
// screen (first-time install token), or the login screen.
type AuthMode = "loading" | "setup" | "login" | "ready";
const authMode = ref<AuthMode>("loading");
const setupInitialToken = ref<string | null>(null);

setUnauthorizedHandler(() => {
    // Token revoked / expired mid-session — drop to the login screen
    // without a full reload so the user's in-flight context isn't
    // disturbed by a slow disk reload.
    if (authMode.value === "ready") authMode.value = "login";
    localStorage.removeItem("aiball.token");
});

function onAuthDone(): void {
    authMode.value = "ready";
    // Clear the install-token query param so the user can't replay the
    // setup link, and drop back to the root path.
    window.history.replaceState({}, "", "/");
}

async function resolveAuthMode(): Promise<void> {
    // If the URL is /setup or carries ?t=, the user clicked the
    // install-token link — show the setup form regardless of any
    // previously stored token.
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get("t");
    if (window.location.pathname === "/setup" || tokenParam) {
        setupInitialToken.value = tokenParam;
        authMode.value = "setup";
        return;
    }
    if (window.location.pathname === "/login") {
        authMode.value = "login";
        return;
    }
    // Have a stored token? Optimistically render the app; first /api
    // call that returns 401 will bounce to /login via the handler.
    if (localStorage.getItem("aiball.token")) {
        authMode.value = "ready";
        return;
    }
    // No token — ask the daemon what mode it's in.
    try {
        const s = await api.authStatus();
        if (!s.ready) {
            authMode.value = "setup";
        } else {
            authMode.value = "login";
        }
    } catch {
        authMode.value = "login";
    }
}

// StatusFilter + SortBy types exported from components/InboxToolbar.vue.

// #B.184 david: the previous "pending" default + per-user localStorage
// stickiness meant projects with auto-approve (e.g. aiball itself)
// landed on an empty moderation queue while the sidebar badges showed
// dozens of open tickets — "compteurs ok mais rien dans les listes".
// Default to "all" so users see content first; moderation queue stays
// one filter-click away. Existing users keep their localStorage choice.
const statusFilter = ref<StatusFilter>(
    (localStorage.getItem("aiball.filter.status") as StatusFilter | null) ?? "all",
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
// #B.222: priority filter — "all" (default) or one of the enum values.
// Persisted in localStorage like the other filters.
const priorityFilter = ref<"all" | import("./lib/api").Priority>(
    (localStorage.getItem("aiball.filter.priority") as "all" | import("./lib/api").Priority | null) ?? "all",
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

// OS notifications + arrival toasts moved to lib/notifications.ts as
// `useNotifications({ project })` (#B.213 phase A.2). The composable
// is wired BELOW once `project` is in scope.

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
// Routed as /consumers/<id> via lib/router.ts (#B.193).
const consumerEditId = ref<string | null>(null);
const automationRuleEditId = ref<string | null>(null);
// Routed as /nodes/<id> via lib/router.ts (#452).
const nodeEditId = ref<string | null>(null);

/**
 * Per-project sub-page (per #B.60). Default null = inbox view. When
 * set to "stats", the main area renders the ProjectStatsPage for the
 * currently selected project. Requires `project !== null` — switching
 * to "All projects" resets it. ProjectPage type lives in Sidebar.vue.
 */
const projectPage = ref<ProjectPage | null>(null);
function openProjectPage(p: string, page: ProjectPage) {
    project.value = p;
    projectPage.value = page;
    panel.value = null;
    openTicketId.value = null;
}

// #462 — user-toggleable layout density, persisted in localStorage. `spread`
// (default) uses min(95vw, 1600px) so the inbox / admin panels / thread view
// use the available screen real estate; `narrow` reverts to the historical
// 980px cap for users who prefer the tighter column. Surfaced in Settings →
// General (david `yag539`: "ajoute une option ... entre spread et comme
// avant").
// The compose form is ALWAYS narrow regardless of the user preference (a
// wide column of inputs doesn't read as a dashboard); if david wants compose
// to also follow the preference, just drop the early-return below.
// Form-style detail pages (Consumer/Node) already self-cap to 40rem via
// `.aiball-detail-page`, so widening the parent is a no-op for them.
type LayoutMode = "spread" | "narrow";
const layoutMode = ref<LayoutMode>(
    localStorage.getItem("aiball.layoutMode") === "narrow" ? "narrow" : "spread",
);
function setLayoutMode(m: LayoutMode): void {
    layoutMode.value = m;
    localStorage.setItem("aiball.layoutMode", m);
}
const aiballMainWide = computed((): boolean => {
    if (panel.value === "compose") return false; // compose form → always narrow
    return layoutMode.value === "spread";
});

// Bulk-selection state + dispatch moved to lib/ticket-actions.ts as
// `useBulkActions(...)` (#B.213 phase A.1). Selected ids, busy flag,
// toggle/clear/selectAll, bulkAction handler, applicability counts +
// the `bulkCounts` computed all come from the composable. Wired below
// once `rows` + `pagedRows` are in scope.
//
// #539 david : auto-refresh polling retiré. WS reverse (`useInboxWs`) push
// les updates en temps réel — le polling 60s était un fallback historique
// inutile (et le bouton manuel idem).

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

watch(project, (v) => {
    if (v) localStorage.setItem("aiball.project", v);
    else localStorage.removeItem("aiball.project");
    // #411: NE PAS wiper openTicketId ici. Ce watcher fire AUSSI pendant la
    // restauration d'URL au boot (useRouting → apply(parseUrl()) pose project
    // depuis `?p=`), ce qui effaçait le ticket fraîchement restauré → un Ctrl-R
    // sur un deep-link cross-projet (ou en multi-onglet) retombait sur l'inbox.
    // Le wipe sur changement de projet *piloté par l'utilisateur* est déjà fait
    // par selectProject / openProjectPage / openPanel ; on ne garde ici que la
    // persistance localStorage, qui doit suivre toutes les sources (URL incluse).
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
        const list = await api.listProjectsDetailed(myConsumerId);
        // Alphabetical (#B.106). The backend returns by last-activity which
        // makes the sidebar reshuffle every time anyone posts — confusing
        // when scanning by name.
        list.sort((a, b) => a.name.localeCompare(b.name));
        projects.value = list;
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
            // #B.222: forward priority filter; "all" → no narrowing.
            ...(priorityFilter.value !== "all" ? { priority: priorityFilter.value } : {}),
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

// #B.213 phase A.2: arrival toasts + OS notifications wired now that
// `project` is in scope (needed for the in-scope filter).
const {
    notifAllowed,
    notifMuted,
    toggleMute,
    ensureNotifPermission,
    notifyArrival,
} = useNotifications({ project });

// WS handler is now a thin relay: turn WebSocket events into high-level
// `bus` events. Consumers (this file's own list/sidebar/toaster, plus any
// future component) subscribe to the bus where they're defined. See
// `lib/bus.ts` for the typed event map.
// #B.213 phase A.3: WS event dispatcher moved to lib/inbox-ws.ts.
// `useInboxWs(...)` takes the strategy ref (for strategy_changed) and
// openTicketId (for message_tagged → thread.refresh fallback) and
// returns the same `connected` signal we expose to the template.
const { connected } = useInboxWs({ strategy, openTicketId });

// Local consumers — same effects as before, just driven by the bus now.
useBus("projects.refresh", () => { loadProjects(); });
useBus("inbox.refresh", () => { loadRows(); });
useBus("message.arrived", (m) => { notifyArrival(m); });
useBus("message.decided", (m) => { notifyArrival(m); });
useBus("project.deleted", ({ project: deleted }) => {
    // If the user is currently scoped to the just-deleted project, fall
    // back to "all projects" so the lists don't sit empty silently.
    // #411: le wipe d'openTicketId n'est plus porté par watch(project) — on le
    // refait explicitement ici pour garder le comportement (fermer le thread
    // ouvert quand son projet disparaît).
    if (project.value === deleted) { project.value = null; openTicketId.value = null; }
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
watch(priorityFilter, (v) => {
    localStorage.setItem("aiball.filter.priority", v);
    // #383: le param `priority` est appliqué côté serveur dans loadRows() —
    // il faut refetch pour que le dropdown narrow réellement la liste. Avant,
    // ce watch ne faisait que persister (page=1 sur le watch L443), jamais
    // recharger → la liste ne bougeait pas. Aligné sur showSnoozed (L603).
    bus.emit("inbox.refresh");
});

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

// #B.222 sxrz48: priority-aware client-side sort. Weight mirrors the
// backend's /api/tickets order so the inbox + sidebar + wake-CTA all
// agree on what "urgent first" means.
const PRIORITY_WEIGHT: Record<string, number> = {
    urgent: 4,
    high: 3,
    normal: 2,
    low: 1,
};

const sortedRows = computed(() => {
    const r = [...rows.value];
    if (sortBy.value === "created_desc") {
        r.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else if (sortBy.value === "created_asc") {
        r.sort((a, b) => a.created_at.localeCompare(b.created_at));
    } else if (sortBy.value === "priority") {
        r.sort((a, b) => {
            const wA = PRIORITY_WEIGHT[a.priority ?? "normal"] ?? 2;
            const wB = PRIORITY_WEIGHT[b.priority ?? "normal"] ?? 2;
            if (wA !== wB) return wB - wA;
            return b.created_at.localeCompare(a.created_at);
        });
    }
    // "activity" is the API default; rows already arrive sorted that way.
    return r;
});

// Client-side pagination of the inbox (#B.74). Server still returns
// everything because the "unread" filter is computed client-side from
// the per-row flag — paginating before that filter would yield ragged
// pages. With ~63 rows total today, paying the bandwidth is trivial.
const DEFAULT_PAGE_SIZE = 25;
const pageSize = ref<number>(
    Number(localStorage.getItem("aiball.page_size")) || DEFAULT_PAGE_SIZE,
);
const page = ref(1);
const pagedRows = computed(() =>
    sortedRows.value.slice(
        (page.value - 1) * pageSize.value,
        page.value * pageSize.value,
    ),
);

// #B.213 phase A.1: bulk-selection state + dispatch wired now that
// both `rows` and `pagedRows` are in scope. selectAllVisible needs
// pagedRows; the rest only need rows.
const {
    selectedIds,
    bulkBusy,
    toggleSelected,
    clearSelection,
    selectAllVisible,
    bulkAction,
    bulkCounts,
} = useBulkActions({ rows, pagedRows });

// Any change to the filter set resets the cursor — otherwise a page-2
// view followed by tightening the filter could leave the user staring
// at an empty page.
watch([statusFilter, onlyOpen, project, showSnoozed, sortBy, searchQuery, priorityFilter],
    () => { page.value = 1; });
watch(pageSize, (v) => {
    localStorage.setItem("aiball.page_size", String(v));
    page.value = 1;
});

useRouting({
    panel,
    openTicketId,
    consumerEditId,
    nodeEditId,
    automationRuleEditId,
    projectPage,
    project,
    statusFilter,
    onlyOpen,
});

onMounted(async () => {
    await resolveAuthMode();
    if (authMode.value !== "ready") return;
    loadProjects();
    loadStrategy();
    loadRows();
});

watch(authMode, (mode) => {
    if (mode === "ready") {
        loadProjects();
        loadStrategy();
        loadRows();
    }
});

function selectProject(p: string | null) {
    project.value = p;
    projectPage.value = null;
    panel.value = null;
    openTicketId.value = null;
}

function openPanel(p: SettingsPanel) {
    panel.value = p;
    projectPage.value = null;
    openTicketId.value = null;
    clearSelection();
}

function openThread(r: InboxRow) {
    openTicketId.value = r.id;
}

/**
 * After a new ticket was just submitted via the compose panel, drop
 * the user straight into the thread we just created (#B.98). Falls
 * back to "back to the list" if the composer couldn't surface an id.
 */
function onNewTicketSubmitted(ticketId: number | null) {
    panel.value = null;
    if (ticketId !== null) {
        openTicketId.value = ticketId;
    }
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

// bulkCounts now comes from useBulkActions (defined above with rows + pagedRows).

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
        local: false,
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
        // #393: a claude-loop with a known root runs here.
        local: p.local === true,
        // #393 (3c): a loop is currently running (rooted consumer heartbeating).
        running: p.running === true,
        // #537 : recency du dernier ticket — drive le critère « inactif si
        // dernier ticket très vieux » dans Sidebar.isProjectActive.
        last_activity: p.last_activity ?? null,
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
/**
 * Total open tickets across every project (the muted "ticket count" the
 * sidebar shows per project, summed). Surfaced as a grey badge in the
 * header so a moderator sees the active backlog at a glance —
 * complements the per-priority badges (pending / resolved / unread /
 * snoozed). When `showSnoozed` is on, snoozed tickets count as open too.
 */
const globalOpenCount = computed(() =>
    projects.value.reduce((acc, p) => acc + projectOpenCount(p), 0),
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
    <div v-if="authMode === 'loading'" class="auth-screen">
        <div class="auth-card"><p>Loading…</p></div>
    </div>
    <SetupScreen
        v-else-if="authMode === 'setup'"
        :initial-token="setupInitialToken"
        @done="onAuthDone"
    />
    <LoginScreen
        v-else-if="authMode === 'login'"
        @done="onAuthDone"
        @need-setup="authMode = 'setup'"
    />
    <div v-else class="aiball-shell aiball-compact">
        <HeaderBar
            :connected="connected"
            :global-pending-count="globalPendingCount"
            :global-resolved-count="globalResolvedCount"
            :global-unread-count="globalUnreadCount"
            :global-snoozed-count="globalSnoozedCount"
            :global-open-count="globalOpenCount"
            :show-snoozed="showSnoozed"
            :dark="dark"
            @update:show-snoozed="showSnoozed = $event"
            @update:dark="dark = $event"
        />

        <div class="aiball-layout">
            <Sidebar
                :items="projectListItems"
                :panel="panel"
                :project="project"
                :project-page="projectPage"
                @select="selectProject"
                @open-panel="openPanel"
                @new-ticket="panel = 'compose'"
                @open-current-settings="project && openProjectPage(project, 'settings')"
            />

            <main class="aiball-main" :class="{ 'aiball-main--wide': aiballMainWide }">
                <!-- #B.194: settings panels lacked a visible way back to
                     the inbox on mobile (the sidebar lives in the footer
                     band, easy to miss). One unified back-link covers
                     all four; per-panel headers stay untouched.
                     #458: suppressed on child detail views (consumer-edit /
                     node-detail) — the page's own DetailHeader breadcrumb
                     prepends an "Inbox" crumb that covers the same job, so
                     showing both stacks two back-links. -->
                <a
                    v-if="(panel === 'general' || (panel === 'automation' && !automationRuleEditId) || panel === 'projects' || panel === 'tags' || (panel === 'consumers' && !consumerEditId) || (panel === 'nodes' && !nodeEditId))"
                    href="/"
                    class="settings-back-link"
                    @click.prevent="panel = null"
                >
                    <i class="pi pi-arrow-left" /> Back to inbox
                </a>
                <GeneralSettingsPanel
                    v-if="panel === 'general'"
                    :strategy="strategy"
                    :strategy-options="strategyOptions"
                    :notif-allowed="notifAllowed"
                    :notif-muted="notifMuted"
                    :layout-mode="layoutMode"
                    @update:strategy="changeStrategy"
                    @enable-notif="ensureNotifPermission"
                    @toggle-mute="toggleMute"
                    @update:layout-mode="setLayoutMode"
                />
                <ProjectsPanel
                    v-else-if="panel === 'projects'"
                    @open-overview="(name: string) => openProjectPage(name, 'overview')"
                />
                <AutomationPanel
                    v-else-if="panel === 'automation'"
                    :edit-rule-id="automationRuleEditId"
                    @open-edit="(id: string) => { automationRuleEditId = id; }"
                    @close-edit="automationRuleEditId = null"
                />
                <TagsPanel v-else-if="panel === 'tags'" />
                <LaunchersPanel v-else-if="panel === 'launchers'" />
                <ConsumersPanel
                    v-else-if="panel === 'consumers'"
                    :edit-consumer-id="consumerEditId"
                    @open-edit="(id: string) => { consumerEditId = id; }"
                    @close-edit="consumerEditId = null"
                    @open-node="(id: string) => { openPanel('nodes'); nodeEditId = id; }"
                    @close-to-inbox="() => { consumerEditId = null; panel = null; }"
                />
                <NodesPanel
                    v-else-if="panel === 'nodes'"
                    :edit-node-id="nodeEditId"
                    @open-edit="(id: string) => { nodeEditId = id; }"
                    @close-edit="nodeEditId = null"
                    @close-to-inbox="() => { nodeEditId = null; panel = null; }"
                />

                <NewTicketPage
                    v-else-if="panel === 'compose'"
                    :initial-project="project"
                    @back="panel = null"
                    @submitted="onNewTicketSubmitted"
                />

                <ThreadView
                    v-else-if="openTicketId !== null"
                    :ticket-id="openTicketId"
                    @back="openTicketId = null"
                />

                <!-- #471 — unified overview = Detail+Stats+Settings tabs + Danger zone. -->
                <ProjectOverviewPage
                    v-else-if="projectPage === 'overview' && project !== null"
                    :project="project"
                    @close="projectPage = null"
                />
                <!-- Legacy deep-link routes — kept for back-compat (#411). -->
                <ProjectSettingsPage
                    v-else-if="projectPage === 'settings' && project !== null"
                    :project="project"
                    @back="projectPage = null"
                />
                <ProjectStatsPage
                    v-else-if="projectPage === 'stats' && project !== null"
                    :project="project"
                    @back="projectPage = null"
                />
                <ProjectDetailPage
                    v-else-if="projectPage === 'detail' && project !== null"
                    :project="project"
                    @back="projectPage = null"
                />

                <template v-else>
                    <!-- #B.127: the per-project strategy hint button
                         lived here as the only entry point. Removed
                         in #B.161 — the sidebar's cog icon next to
                         the project name (#B.169) replaces it. -->

                    <InboxToolbar
                        :status-filter="statusFilter"
                        :status-filter-options="statusFilterOptions"
                        :only-open="onlyOpen"
                        :sort-by="sortBy"
                        :sort-options="sortOptions"
                        :search-query="searchQuery"
                        :project="project"
                        :project-options="projectListItems.map(p => ({
                            label: p.label,
                            value: p.value,
                            pending: p.pending,
                            unread: p.unread,
                            open: p.open,
                            resolved: p.resolved,
                            running: p.running,
                            last_activity: p.last_activity,
                        }))"
                        :priority-filter="priorityFilter"
                        @update:status-filter="statusFilter = $event"
                        @update:only-open="onlyOpen = $event"
                        @update:sort-by="sortBy = $event"
                        @update:search-query="searchQuery = $event"
                        @update:project="selectProject"
                        @update:priority-filter="priorityFilter = $event"
                        @open-current-settings="project && openProjectPage(project, 'settings')"
                        @new-ticket="panel = 'compose'"
                    />

                    <InboxList
                        :loading="loading"
                        :rows="pagedRows"
                        :project="project"
                        :selected-ids="selectedIds"
                        :search-active="searchActive"
                        :search-hits="searchHits"
                        :search-query="searchQuery"
                        :status-filter="statusFilter"
                        :only-open="onlyOpen"
                        @open-row="openThread"
                        @open-hit="openSearchHit"
                        @toggle-read="toggleRead"
                        @toggle-selected="toggleSelected"
                        @reset-filters="statusFilter = 'all'; onlyOpen = true"
                    />

                    <PaginationBar
                        v-if="!searchActive && sortedRows.length > 0"
                        :page="page"
                        :page-size="pageSize"
                        :total="sortedRows.length"
                        @update:page="page = $event"
                        @update:page-size="pageSize = $event"
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

                <!-- #B.161: mobile-only settings footer. Rendered
                     INSIDE main so it scrolls with the inbox/thread
                     instead of sitting always-visible at the
                     viewport bottom (david: "le footer settings
                     doit pas etre par desus les tickets mais à la
                     suite, visible que si on scrolle vers le bas").
                     Hidden on desktop — the sidebar exposes these. -->
                <aside class="aiball-footer-settings">
                    <div class="aiball-footer-settings__label">Settings</div>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('general')">
                        <i class="pi pi-sliders-h" /> <span>General</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('projects')">
                        <i class="pi pi-folder" /> <span>Projects</span>
                    </button>
                    <!-- #457 david `92wub9` : le menu mobile était en
                         retard sur le desktop (entrées `Rules` + `Work
                         filters` séparées au lieu de l'unifiée
                         `Automation`). Remplacé par la seule entrée
                         `Automation` (⚡), mirror du Sidebar.vue. -->
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('automation')">
                        <i class="pi pi-bolt" /> <span>Automation</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('tags')">
                        <i class="pi pi-tag" /> <span>Tags</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('consumers')">
                        <i class="pi pi-users" /> <span>Consumers</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('nodes')">
                        <i class="pi pi-sitemap" /> <span>Nodes</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('launchers')">
                        <i class="pi pi-play" /> <span>Launchers</span>
                    </button>
                </aside>
            </main>
        </div>

        <Toast position="top-right" />
        <!-- #309: global confirm dialog (used by the comment delete button). -->
        <ConfirmDialog />
    </div>
</template>

<style>
/* App-level layout. Component-specific rules live in each
   component's own &lt;style&gt; block (Phase C of #B.332). */
.aiball-layout {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    gap: 0;
    flex: 1;
    min-height: 0;
    /* #B.134: own the vertical overflow so sidebar + main get
       independent scroll contexts — the sidebar stays put when the
       user scrolls a long ticket thread. */
    overflow: hidden;
}

/* #B.127: discrete pointer to the per-project strategy panel — surfaced
   in the inbox header so the feature is discoverable from the user's
   daily view. Click → opens ProjectStatsPage where the selector lives. */
.project-strategy-hint {
    align-self: flex-start;
    appearance: none;
    background: transparent;
    border: 1px dashed var(--p-content-border-color);
    color: var(--p-text-muted-color);
    border-radius: 0.3rem;
    padding: 0.25rem 0.6rem;
    font-size: 0.78rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
}
.project-strategy-hint:hover {
    background: var(--p-surface-100);
    color: var(--p-text-color);
}

.settings-back-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--p-primary-color);
    text-decoration: none;
    font-size: 0.9rem;
    align-self: flex-start;
}
.settings-back-link:hover { text-decoration: underline; }

.aiball-main {
    padding: 1rem;
    max-width: 980px;
    width: 100%;
    margin: 0 auto;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    /* #B.134: fill the layout cell and own the vertical scroll so the
       sidebar (sibling) stays static while the thread scrolls. */
    height: 100%;
    overflow-y: auto;
}

/* #462 — wide modifier for table-style + admin content (inbox list, admin
   panels, dashboard pages, list/show detail pages, AND the ticket thread —
   david `b33tdr` reversed my initial exclusion of the thread). Only the
   compose form keeps the narrow default (focused entry surface). Form-style
   pages (consumer/node detail) already self-cap to .aiball-detail-page
   (40rem) so widening the parent is a no-op for them — the wider container
   only matters where the page DOESN'T self-constrain.

   `min(95vw, 1600px)` : on a typical 1280-1920 viewport we get 95% of the
   width (a small breathing margin keeps content off the absolute edge); on
   4K / ultra-wide we cap at 1600px so a paragraph never becomes unreadable
   wide. Vue applies this class via the `aiballMainWide` computed in App.vue. */
.aiball-main--wide {
    max-width: min(95vw, 1600px);
}

.compose-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0;
}

@media (max-width: 720px) {
    .aiball-layout {
        grid-template-columns: 1fr;
    }
    .aiball-sidebar {
        /* #B.161 v4: sidebar hidden on mobile — project picker +
           cog moved into the InboxToolbar (no more gray-vs-white
           rupture between two stacked bars). */
        display: none;
    }
    .aiball-main {
        /* #609 david : en smartphone on supprime le padding horizontal
           pour que les list-rows et les comment-cards atteignent les
           bords de l'écran (les bordures gauche/droite inutiles
           disparaissent). On garde le padding vertical pour respirer.
           Le padding interne des rows + cards garde le texte aéré. */
        padding: 0.5rem 0;
    }
    /* #B.161 v3: footer settings rendered INSIDE main so it scrolls
       with the inbox content — user only sees it after scrolling
       past the ticket list. Margin-top: auto positions it at the
       bottom of main's scroll area when content is short. */
    .aiball-footer-settings {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        margin-top: 2rem;
        padding: 0.5rem 0.6rem;
        background: var(--p-surface-50);
        border-top: 1px solid var(--p-content-border-color);
    }
    .aiball-footer-settings__label {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--p-text-muted-color);
        padding: 0.3rem 0.5rem 0.2rem;
    }
    .aiball-footer-settings__item {
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
    .aiball-footer-settings__item:hover {
        background: var(--p-surface-100);
    }

    /* #B.161 → #B.255 update: the per-row checkbox stays hidden on
       phone (long-press is the entry mechanism now), but the bulk
       action bar MUST surface once selection mode is active —
       otherwise the long-press gesture has no visible outcome on
       mobile. David #rvssy2. */
    .list-row__select {
        display: none !important;
    }
}
@media (max-width: 720px) {
    /* Mobile toasts edge-to-edge AT THE BOTTOM so they don't cover
       header + dropdown menus (#B.165, #B.161, #B.187). */
    .p-toast {
        bottom: 0.25rem !important;
        top: auto !important;
        right: 0.25rem !important;
        left: 0.25rem !important;
        width: calc(100vw - 0.5rem) !important;
        max-width: none !important;
    }
    .p-toast .p-toast-message {
        max-width: 100%;
    }
    .p-toast .p-toast-message-content {
        padding: 0.5rem 0.6rem;
    }
    .p-toast .p-toast-detail {
        display: none;
    }
    .p-toast .p-toast-summary {
        font-size: 0.92rem;
    }
}
@media (min-width: 721px) {
    /* Desktop: footer-settings is the mobile-only band; hide it
       since the sidebar already exposes Projects/Rules/Tags/
       Consumers. */
    .aiball-footer-settings {
        display: none;
    }
    /* #B.161: desktop toast — explicit small width pinned to the
       top-right. PrimeVue's default in this version still rendered
       full-width despite position="top-right"; override directly. */
    .p-toast {
        position: fixed !important;
        top: 1rem !important;
        right: 1rem !important;
        left: auto !important;
        bottom: auto !important;
        width: 24rem !important;
        max-width: 24rem !important;
    }
}
/* #B.161: PrimeVue draws an inconsistent circle around the close X
   on warn-severity toasts only (background bleed from a hover/focus
   pseudo). Normalize across severities — flat icon, no bg. */
.p-toast-close-button,
.p-toast-message-icon-close,
.p-toast .p-button.p-button-icon-only {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
}
</style>

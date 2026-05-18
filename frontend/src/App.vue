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
import PaginationBar from "./components/PaginationBar.vue";
import NewTicketPage from "./components/NewTicketPage.vue";
import ProjectStatsPage from "./components/ProjectStatsPage.vue";
import ProjectSettingsPage from "./components/ProjectSettingsPage.vue";
import ProjectsPanel from "./components/ProjectsPanel.vue";
import ConsumersPanel from "./components/ConsumersPanel.vue";
import RulesPanel from "./components/RulesPanel.vue";
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
// Routed as /consumers/<id> via lib/router.ts (#B.193).
const consumerEditId = ref<string | null>(null);

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
    // "Visible" = the current page's rows. With pagination on, selecting
    // "all" across every page would be surprising; the user sees 25 rows
    // and expects the button to act on those. To select across pages,
    // they can paginate + select-all again — selectedIds persists.
    selectedIds.value = new Set(pagedRows.value.map((r) => r.id));
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

// Catch up after a WS reconnect (mobile freeze most commonly) —
// any event missed while the socket was down won't replay (#B.191).
watch(connected, (now, prev) => {
    if (now && prev === false) {
        bus.emit("inbox.refresh");
        bus.emit("projects.refresh");
    }
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

// Client-side pagination of the inbox (#B.74). Server still returns
// everything because the "unread" filter is computed client-side from
// the per-row flag — paginating before that filter would yield ragged
// pages. With ~63 rows total today, paying the bandwidth is trivial.
const DEFAULT_PAGE_SIZE = 25;
const pageSize = ref<number>(
    Number(localStorage.getItem("aiball.page_size")) || DEFAULT_PAGE_SIZE,
);
const page = ref(1);
const totalPages = computed(() =>
    Math.max(1, Math.ceil(sortedRows.value.length / pageSize.value)),
);
const pagedRows = computed(() =>
    sortedRows.value.slice(
        (page.value - 1) * pageSize.value,
        page.value * pageSize.value,
    ),
);

// Any change to the filter set resets the cursor — otherwise a page-2
// view followed by tightening the filter could leave the user staring
// at an empty page.
watch([statusFilter, onlyOpen, project, showSnoozed, sortBy, searchQuery],
    () => { page.value = 1; });
watch(pageSize, (v) => {
    localStorage.setItem("aiball.page_size", String(v));
    page.value = 1;
});

useRouting({
    panel,
    openTicketId,
    consumerEditId,
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
                :project-page="projectPage"
                @select="selectProject"
                @open-panel="openPanel"
                @new-ticket="panel = 'compose'"
                @open-current-settings="project && openProjectPage(project, 'settings')"
            />

            <main class="aiball-main">
                <ProjectsPanel
                    v-if="panel === 'projects'"
                    @open-stats="(name: string) => openProjectPage(name, 'stats')"
                    @open-settings="(name: string) => openProjectPage(name, 'settings')"
                />
                <RulesPanel v-else-if="panel === 'rules'" />
                <TagsPanel v-else-if="panel === 'tags'" />
                <ConsumersPanel
                    v-else-if="panel === 'consumers'"
                    :edit-consumer-id="consumerEditId"
                    @open-edit="(id: string) => { consumerEditId = id; }"
                    @close-edit="consumerEditId = null"
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
                        }))"
                        @update:status-filter="statusFilter = $event"
                        @update:only-open="onlyOpen = $event"
                        @update:sort-by="sortBy = $event"
                        @update:search-query="searchQuery = $event"
                        @update:project="selectProject"
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
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('projects')">
                        <i class="pi pi-folder" /> <span>Projects</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('rules')">
                        <i class="pi pi-cog" /> <span>Rules</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('tags')">
                        <i class="pi pi-tag" /> <span>Tags</span>
                    </button>
                    <button type="button" class="aiball-footer-settings__item" @click="openPanel('consumers')">
                        <i class="pi pi-users" /> <span>Consumers</span>
                    </button>
                </aside>
            </main>
        </div>

        <Toast position="top-right" />
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
.aiball-dark .project-strategy-hint:hover {
    background: var(--p-surface-800);
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
    /* #B.134: fill the layout cell and own the vertical scroll so the
       sidebar (sibling) stays static while the thread scrolls. */
    height: 100%;
    overflow-y: auto;
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
        padding: 0.5rem;
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
    .aiball-dark .aiball-footer-settings {
        background: var(--p-surface-900);
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
    .aiball-dark .aiball-footer-settings__item:hover {
        background: var(--p-surface-800);
    }

    /* #B.161: bulk actions (per-row checkbox + "select all" footer)
       are awkward on a phone — hide them entirely. The thread view
       still offers per-ticket actions for individual ops. */
    .list-row__select {
        display: none !important;
    }
    .bulk-bar {
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

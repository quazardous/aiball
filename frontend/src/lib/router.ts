import { onBeforeUnmount, watch, type Ref } from "vue";
import { pushRoute } from "./base";

export type RouteState = {
    panel: "general" | "automation" | "rules" | "work-filters" | "tags" | "projects" | "consumers" | "nodes" | "launchers" | "usage" | "compose" | null;
    openTicketId: number | null;
    /** Set on `/consumers/<id>` — ConsumersPanel renders the edit view (#B.193). */
    consumerEditId: string | null;
    /** Set on `/nodes/<id>` — NodesPanel renders the detail view (#452). */
    nodeEditId: string | null;
    /** #457 slice 5.3a — set on `/automation/rules/<id>` (or `"new"`) ;
     *  AutomationPanel renders AutomationRuleDetailPage instead of the
     *  list section. */
    automationRuleEditId: string | null;
    /** #411 — project-scoped full pages (stats/settings/detail/overview). Requires
     *  `project !== null`; encoded as `/stats|/settings|/detail|/overview` + `?p=`,
     *  so a Ctrl-R on a project page restores it instead of dropping to inbox.
     *  Union mirrors ProjectPage in components/Sidebar.vue (inlined to keep
     *  this lib free of a .vue import). #471 added `overview` — the canonical
     *  entry from the projects list, hosting Detail/Stats/Settings in tabs. */
    projectPage: "stats" | "settings" | "detail" | "overview" | null;
    project: string | null;
    statusFilter: "all" | "unread" | "pending" | "approved" | "rejected";
    onlyOpen: boolean;
};

const DEFAULTS = {
    statusFilter: "pending" as const,
    onlyOpen: true,
};

export function buildUrl(s: RouteState): string {
    let path = "/";
    if (s.panel === "general") path = "/general";
    else if (s.panel === "automation") {
        path = s.automationRuleEditId
            ? `/automation/rules/${encodeURIComponent(s.automationRuleEditId)}`
            : "/automation";
    }
    else if (s.panel === "rules") path = "/rules";
    else if (s.panel === "work-filters") path = "/work-filters";
    else if (s.panel === "usage") path = "/usage";
    else if (s.panel === "tags") path = "/tags";
    else if (s.panel === "projects") path = "/projects";
    else if (s.panel === "consumers") {
        path = s.consumerEditId
            ? `/consumers/${encodeURIComponent(s.consumerEditId)}`
            : "/consumers";
    }
    else if (s.panel === "nodes") {
        path = s.nodeEditId
            ? `/nodes/${encodeURIComponent(s.nodeEditId)}`
            : "/nodes";
    }
    else if (s.panel === "launchers") path = "/launchers";
    else if (s.panel === "compose") path = "/new";
    // #411 — project pages (project carried by `?p=` below, always set here).
    else if (s.projectPage === "stats") path = "/stats";
    else if (s.projectPage === "settings") path = "/settings";
    else if (s.projectPage === "detail") path = "/detail";
    else if (s.projectPage === "overview") path = "/overview";
    else if (s.openTicketId !== null) path = `/b/${s.openTicketId}`;

    const qs = new URLSearchParams();
    if (s.project) qs.set("p", s.project);
    if (s.statusFilter !== DEFAULTS.statusFilter) qs.set("status", s.statusFilter);
    if (s.onlyOpen !== DEFAULTS.onlyOpen) qs.set("open", s.onlyOpen ? "1" : "0");
    const query = qs.toString();
    // Returns the route path ; pushIfChanged writes it into the URL hash
    // (#190 hash routing) and parseUrl reads it back from there.
    return path + (query ? "?" + query : "");
}

/**
 * Parse the URL into a state delta. Path always sets panel/openTicketId
 * (so back/forward reliably leave a thread). Query params only override the
 * filter refs when they are explicitly present, so visiting "/" preserves the
 * filter values the user already had loaded (typically from localStorage).
 */
export function parseUrl(): Partial<RouteState> {
    // #190 — the route lives in the URL HASH (`/base/#/b/981?status=all`), so the
    // served path stays the base regardless of route. Source path + query from
    // the hash, base-agnostic.
    const raw = location.hash.replace(/^#/, "");
    const [rawPath, rawQuery = ""] = raw.split("?");
    const path = rawPath || "/";
    const qs = new URLSearchParams(rawQuery);
    const out: Partial<RouteState> = {};
    // Default to null so navigating away from /consumers/<id> clears the edit view.
    out.consumerEditId = null;
    // Default to null so navigating away from /nodes/<id> clears the detail view.
    out.nodeEditId = null;
    // #457 slice 5.3a — same as above for the automation rule detail view.
    out.automationRuleEditId = null;
    // #411 — default to null so navigating away from a project page clears it.
    out.projectPage = null;

    if (path === "/general") {
        out.panel = "general";
        out.openTicketId = null;
    } else if (path === "/automation") {
        out.panel = "automation";
        out.openTicketId = null;
        out.automationRuleEditId = null;
    } else if (path.startsWith("/automation/rules/")) {
        out.panel = "automation";
        out.openTicketId = null;
        const raw = path.slice("/automation/rules/".length);
        out.automationRuleEditId = raw ? decodeURIComponent(raw) : null;
    } else if (path === "/rules") {
        out.panel = "rules";
        out.openTicketId = null;
    } else if (path === "/work-filters") {
        out.panel = "work-filters";
    } else if (path === "/usage") {
        out.panel = "usage";
        out.openTicketId = null;
    } else if (path === "/tags") {
        out.panel = "tags";
        out.openTicketId = null;
    } else if (path === "/projects") {
        out.panel = "projects";
        out.openTicketId = null;
    } else if (path === "/consumers") {
        out.panel = "consumers";
        out.openTicketId = null;
        out.consumerEditId = null;
    } else if (path.startsWith("/consumers/")) {
        out.panel = "consumers";
        out.openTicketId = null;
        const raw = path.slice("/consumers/".length);
        out.consumerEditId = raw ? decodeURIComponent(raw) : null;
    } else if (path === "/nodes") {
        out.panel = "nodes";
        out.openTicketId = null;
        out.nodeEditId = null;
    } else if (path.startsWith("/nodes/")) {
        out.panel = "nodes";
        out.openTicketId = null;
        const raw = path.slice("/nodes/".length);
        out.nodeEditId = raw ? decodeURIComponent(raw) : null;
    } else if (path === "/launchers") {
        out.panel = "launchers";
        out.openTicketId = null;
    } else if (path === "/new") {
        out.panel = "compose";
        out.openTicketId = null;
    } else if (
        path === "/stats" ||
        path === "/settings" ||
        path === "/detail" ||
        path === "/overview"
    ) {
        // #411 — project page; the project itself comes from `?p=` below.
        // #471 — `/overview` is the new unified entry (Tabs).
        out.panel = null;
        out.openTicketId = null;
        out.projectPage = path.slice(1) as RouteState["projectPage"];
    } else if (path.startsWith("/b/") || path.startsWith("/t/")) {
        // /b/N is canonical; /t/N is kept as a backward-compatible alias for
        // older bookmarks and any markdown rendered before the rename.
        const id = parseInt(path.slice(3), 10);
        out.panel = null;
        out.openTicketId = Number.isNaN(id) ? null : id;
    } else {
        out.panel = null;
        out.openTicketId = null;
    }

    if (qs.has("p")) out.project = qs.get("p") || null;
    const st = qs.get("status");
    if (
        st === "pending" ||
        st === "approved" ||
        st === "rejected" ||
        st === "unread" ||
        st === "all"
    ) {
        out.statusFilter = st;
    }
    if (qs.has("open")) out.onlyOpen = qs.get("open") === "1";
    return out;
}

/**
 * Bind a set of refs to URL state with push-state navigation:
 *   - On mount, parse the URL and write it into the refs (initial sync).
 *   - When refs change, push the new URL onto the history stack (no reload).
 *   - When the user uses back/forward, popstate fires and we re-sync the refs.
 *
 * The `applying` flag prevents the ref→URL watcher from re-pushing while we
 * are coming from the URL (popstate or initial parse).
 */
export function useRouting(refs: {
    panel: Ref<RouteState["panel"]>;
    openTicketId: Ref<number | null>;
    consumerEditId: Ref<string | null>;
    nodeEditId: Ref<string | null>;
    automationRuleEditId: Ref<string | null>;
    projectPage: Ref<RouteState["projectPage"]>;
    project: Ref<string | null>;
    statusFilter: Ref<RouteState["statusFilter"]>;
    onlyOpen: Ref<boolean>;
}) {
    let applying = false;

    function snapshot(): RouteState {
        return {
            panel: refs.panel.value,
            openTicketId: refs.openTicketId.value,
            consumerEditId: refs.consumerEditId.value,
            nodeEditId: refs.nodeEditId.value,
            automationRuleEditId: refs.automationRuleEditId.value,
            projectPage: refs.projectPage.value,
            project: refs.project.value,
            statusFilter: refs.statusFilter.value,
            onlyOpen: refs.onlyOpen.value,
        };
    }

    function apply(state: Partial<RouteState>) {
        applying = true;
        if ("panel" in state) refs.panel.value = state.panel ?? null;
        if ("openTicketId" in state) refs.openTicketId.value = state.openTicketId ?? null;
        if ("consumerEditId" in state) refs.consumerEditId.value = state.consumerEditId ?? null;
        if ("nodeEditId" in state) refs.nodeEditId.value = state.nodeEditId ?? null;
        if ("automationRuleEditId" in state) refs.automationRuleEditId.value = state.automationRuleEditId ?? null;
        if ("projectPage" in state) refs.projectPage.value = state.projectPage ?? null;
        if ("project" in state) refs.project.value = state.project ?? null;
        if ("statusFilter" in state && state.statusFilter)
            refs.statusFilter.value = state.statusFilter;
        if ("onlyOpen" in state && typeof state.onlyOpen === "boolean")
            refs.onlyOpen.value = state.onlyOpen;
        // Release the lock on next microtask so watchers see the change without pushing.
        Promise.resolve().then(() => {
            applying = false;
        });
    }

    apply(parseUrl());

    function pushIfChanged() {
        if (applying) return;
        const url = buildUrl(snapshot());
        // #190 — route lives in the hash ; compare + write there.
        const current = location.hash.replace(/^#/, "") || "/";
        if (url !== current) pushRoute(url);
    }

    const stop = watch(
        [
            refs.panel,
            refs.openTicketId,
            refs.consumerEditId,
            refs.nodeEditId,
            refs.automationRuleEditId,
            refs.projectPage,
            refs.project,
            refs.statusFilter,
            refs.onlyOpen,
        ],
        pushIfChanged,
    );

    function onPop() {
        apply(parseUrl());
    }
    window.addEventListener("popstate", onPop);
    // #190 — hash routing : a manual URL edit / external #-link fires hashchange
    // (not popstate), so re-sync on both.
    window.addEventListener("hashchange", onPop);
    onBeforeUnmount(() => {
        window.removeEventListener("popstate", onPop);
        window.removeEventListener("hashchange", onPop);
        stop();
    });
}

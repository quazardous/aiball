import { onBeforeUnmount, watch, type Ref } from "vue";

export type RouteState = {
    panel: "rules" | "tags" | "projects" | null;
    openTicketId: number | null;
    project: string | null;
    statusFilter: "all" | "pending" | "approved" | "rejected";
    intentFilter: "all" | "panic" | "request" | "question" | "fyi";
    onlyOpen: boolean;
};

const DEFAULTS = {
    statusFilter: "pending" as const,
    intentFilter: "all" as const,
    onlyOpen: true,
};

export function buildUrl(s: RouteState): string {
    let path = "/";
    if (s.panel === "rules") path = "/rules";
    else if (s.panel === "tags") path = "/tags";
    else if (s.panel === "projects") path = "/projects";
    else if (s.openTicketId !== null) path = `/b/${s.openTicketId}`;

    const qs = new URLSearchParams();
    if (s.project) qs.set("p", s.project);
    if (s.statusFilter !== DEFAULTS.statusFilter) qs.set("status", s.statusFilter);
    if (s.intentFilter !== DEFAULTS.intentFilter) qs.set("intent", s.intentFilter);
    if (s.onlyOpen !== DEFAULTS.onlyOpen) qs.set("open", s.onlyOpen ? "1" : "0");
    const query = qs.toString();
    return path + (query ? "?" + query : "");
}

/**
 * Parse the URL into a state delta. Path always sets panel/openTicketId
 * (so back/forward reliably leave a thread). Query params only override the
 * filter refs when they are explicitly present, so visiting "/" preserves the
 * filter values the user already had loaded (typically from localStorage).
 */
export function parseUrl(): Partial<RouteState> {
    const path = location.pathname;
    const qs = new URLSearchParams(location.search);
    const out: Partial<RouteState> = {};

    if (path === "/rules") {
        out.panel = "rules";
        out.openTicketId = null;
    } else if (path === "/tags") {
        out.panel = "tags";
        out.openTicketId = null;
    } else if (path === "/projects") {
        out.panel = "projects";
        out.openTicketId = null;
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
    if (st === "pending" || st === "approved" || st === "rejected" || st === "all") {
        out.statusFilter = st;
    }
    const pr = qs.get("intent");
    if (pr === "panic" || pr === "request" || pr === "question" || pr === "fyi" || pr === "all") {
        out.intentFilter = pr;
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
    project: Ref<string | null>;
    statusFilter: Ref<RouteState["statusFilter"]>;
    intentFilter: Ref<RouteState["intentFilter"]>;
    onlyOpen: Ref<boolean>;
}) {
    let applying = false;

    function snapshot(): RouteState {
        return {
            panel: refs.panel.value,
            openTicketId: refs.openTicketId.value,
            project: refs.project.value,
            statusFilter: refs.statusFilter.value,
            intentFilter: refs.intentFilter.value,
            onlyOpen: refs.onlyOpen.value,
        };
    }

    function apply(state: Partial<RouteState>) {
        applying = true;
        if ("panel" in state) refs.panel.value = state.panel ?? null;
        if ("openTicketId" in state) refs.openTicketId.value = state.openTicketId ?? null;
        if ("project" in state) refs.project.value = state.project ?? null;
        if ("statusFilter" in state && state.statusFilter)
            refs.statusFilter.value = state.statusFilter;
        if ("intentFilter" in state && state.intentFilter)
            refs.intentFilter.value = state.intentFilter;
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
        const current = location.pathname + location.search;
        if (url !== current) history.pushState({}, "", url);
    }

    const stop = watch(
        [
            refs.panel,
            refs.openTicketId,
            refs.project,
            refs.statusFilter,
            refs.intentFilter,
            refs.onlyOpen,
        ],
        pushIfChanged,
    );

    function onPop() {
        apply(parseUrl());
    }
    window.addEventListener("popstate", onPop);
    onBeforeUnmount(() => {
        window.removeEventListener("popstate", onPop);
        stop();
    });
}

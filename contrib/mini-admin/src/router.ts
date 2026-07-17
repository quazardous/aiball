import { computed, ref } from "vue";

// STEP 4 — menu + breadcrumb.
//
// The frontend's lib/router.ts could not be reused. Its RouteState is a fixed
// union of aiball's own panels ("general" | "automation" | "rules" | …) with
// inbox concepts (statusFilter, onlyOpen, openTicketId) welded into the type,
// and buildUrl/parseUrl are two symmetric if/else chains over those literals.
// There is no route-registration API: a page is added by editing the union AND
// both chains. Nothing of it is available to a second app.
//
// So the demo writes its own — as a TABLE, which is what makes the breadcrumb
// derivable. That contrast is the finding: aiball's breadcrumbs are hand-written
// per page precisely because its router has no tree to derive a parent from.

export interface Route {
    path: string;
    label: string;
    /** Parent route path — the breadcrumb walks this up. */
    parent?: string;
    /** Shown in the nav menu. Detail routes are reachable but not listed. */
    inMenu?: boolean;
}

export const ROUTES: Route[] = [
    { path: "/", label: "Home", inMenu: true },
    { path: "/widgets", label: "Widgets", parent: "/", inMenu: true },
    { path: "/widgets/:id", label: "Widget", parent: "/widgets" },
];

export interface Crumb {
    label: string;
    href?: string;
}

const current = ref<string>(readHash());

function readHash(): string {
    const raw = location.hash.replace(/^#/, "");
    return raw || "/";
}

window.addEventListener("hashchange", () => {
    current.value = readHash();
});

export function navigate(path: string): void {
    location.hash = path;
}

/** Match a concrete path against the table, returning the route + its params. */
function match(path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of ROUTES) {
        const rp = route.path.split("/");
        const cp = path.split("/");
        if (rp.length !== cp.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < rp.length; i++) {
            if (rp[i].startsWith(":")) params[rp[i].slice(1)] = decodeURIComponent(cp[i]);
            else if (rp[i] !== cp[i]) { ok = false; break; }
        }
        if (ok) return { route, params };
    }
    return null;
}

export const currentPath = computed<string>(() => current.value);
export const currentMatch = computed(() => match(current.value));

export const menu = computed<Route[]>(() => ROUTES.filter((r) => r.inMenu));

/**
 * The breadcrumb the kit cannot build for you. Derived by walking `parent` up
 * the table — which is exactly what aiball's router cannot do, so its eight
 * pages hand-write the chain and have already drifted apart.
 */
export const crumbs = computed<Crumb[]>(() => {
    const m = currentMatch.value;
    if (!m) return [];
    const chain: Crumb[] = [];
    let parent = m.route.parent;
    while (parent) {
        const p: Route | undefined = ROUTES.find((r) => r.path === parent);
        if (!p) break;
        chain.unshift({ label: p.label, href: `#${p.path}` });
        parent = p.parent;
    }
    return chain;
});

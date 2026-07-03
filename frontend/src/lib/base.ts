/**
 * #190 — base-path awareness, fully RUNTIME (no build flag, no hardcoded path).
 *
 * aiball can be served under any sub-path (`/aiball`, `/xyz/…`) so it coexists
 * with another service on the same host/port (cf. #986). One build runs under
 * any mount because:
 *  - assets are emitted RELATIVE (vite `base: "./"`), so they resolve against
 *    wherever index.html was served ;
 *  - the SPA routes via the URL HASH (`/xyz/#/b/981`), so the served PATH is
 *    always the base itself (the route never reaches the server / the pathname) ;
 *  - `BASE_PATH` is discovered at load from the bundle URL — generic, no list.
 *
 * `BASE_PATH` is "" (root) or "/aiball" (no trailing slash), prefixed onto the
 * fetch() URLs Vite does not rewrite (`/api`, `/uploads`, `/ws`).
 */

/** Prefix `path` (app-absolute, e.g. "/api/x") with `base` (""|"/aiball"). Pure. */
export function joinBase(base: string, path: string): string {
    return base + path;
}

/** Strip `base` from a `location.pathname`. Pure. "/aiball/setup" → "/setup". */
export function stripBaseFrom(base: string, pathname: string): string {
    if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
        return pathname.slice(base.length) || "/";
    }
    return pathname;
}

/** Discover the base from the running bundle's URL. Every chunk is emitted under
 *  `<base>/assets/…`, so the path before `/assets/` is the base — generic, works
 *  for any mount, no hardcoded route list. "" when at root or off-Vite (tests). */
function detectBase(): string {
    try {
        const { pathname } = new URL(import.meta.url);
        const i = pathname.indexOf("/assets/");
        return (i >= 0 ? pathname.slice(0, i) : "").replace(/\/+$/, "");
    } catch {
        return "";
    }
}

/** Active base, normalized: "" (root) or "/aiball" (no trailing slash). */
export const BASE_PATH: string = detectBase();

/** Prefix an app-absolute fetch path (`/api/x`, `/ws`) with the active base. */
export function withBase(path: string): string {
    return joinBase(BASE_PATH, path);
}

/** Strip the active base off a pathname (for the auth-entry /setup,/login check). */
export function stripBase(pathname: string): string {
    return stripBaseFrom(BASE_PATH, pathname);
}

/** #190 — navigate to an app route via the HASH (keeps the served path = base).
 *  `route` is the app-absolute route, e.g. "/b/981?status=all". Single chokepoint
 *  so callers never touch history/base themselves (david). */
export function pushRoute(route: string): void {
    window.history.pushState({}, "", `#${route}`);
}

/** #190 — canonical `<a href>` for an app route. Mirror of {@link pushRoute}
 *  for the declarative (anchor) side: routes live in the URL HASH, so a static
 *  link must be `#${route}` (keeps the served path = base ; a bare `/b/N` would
 *  hard-navigate to a server path that doesn't exist). Single chokepoint so
 *  anchors never hardcode the `#` and can't drift back to the path form.
 *  `route` is the app-absolute route, e.g. "/b/981". */
export function routeHref(route: string): string {
    return `#${route}`;
}

/** Convenience: canonical anchor href for a ticket by id (or hashid). */
export function ticketHref(idOrHashid: number | string): string {
    return routeHref(`/b/${idOrHashid}`);
}

/** Drop back to the app root (base path, no route hash, no query). Used after
 *  the auth/setup flow to clear the install-token param. */
export function resetToRoot(): void {
    window.history.replaceState({}, "", withBase("/"));
}

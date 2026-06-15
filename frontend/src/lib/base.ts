/**
 * #190 — base-path awareness. aiball can be served under a sub-path (e.g.
 * `/aiball`) instead of root, so it coexists with another service on the same
 * host/port (cf. #986). Vite's `base` (set via `AIBALL_BASE` at build) drives
 * asset URLs automatically AND exposes `import.meta.env.BASE_URL`; this module
 * turns that into helpers for the things Vite does NOT rewrite for us: the
 * fetch() URLs (`/api`, `/uploads`), the custom history router, and internal
 * `<a href>`s.
 *
 * `BASE_PATH` is normalized to "" (root) or "/aiball" (no trailing slash) so it
 * can be string-prefixed onto app-absolute paths.
 */

/** Prefix `path` (app-absolute, e.g. "/api/x") with `base` (""|"/aiball"). Pure. */
export function joinBase(base: string, path: string): string {
    return base + path;
}

/** Strip `base` from a `location.pathname` before route parsing. Pure.
 *  "/aiball/b/1" → "/b/1" ; "/aiball" → "/" ; anything outside the base is
 *  returned unchanged. */
export function stripBaseFrom(base: string, pathname: string): string {
    if (base && (pathname === base || pathname.startsWith(`${base}/`))) {
        return pathname.slice(base.length) || "/";
    }
    return pathname;
}

/** Configured base, normalized: "" (root) or "/aiball" (no trailing slash).
 *  `import.meta.env?.` so the module is importable outside Vite (node tests). */
export const BASE_PATH: string = (import.meta.env?.BASE_URL || "/").replace(/\/+$/, "");

/** Prefix an app-absolute path with the active base. */
export function withBase(path: string): string {
    return joinBase(BASE_PATH, path);
}

/** Strip the active base from a pathname (for the router's parse step). */
export function stripBase(pathname: string): string {
    return stripBaseFrom(BASE_PATH, pathname);
}

/** #190 — history.pushState to an app-absolute path (e.g. "/b/1"), base-prefixed.
 *  Single chokepoint so callers never deal with the base themselves. */
export function pushBasePath(path: string): void {
    window.history.pushState({}, "", withBase(path));
}

/** history.replaceState variant of {@link pushBasePath}. */
export function replaceBasePath(path: string): void {
    window.history.replaceState({}, "", withBase(path));
}

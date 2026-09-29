/**
 * #1179 — the path the daemon is served under (`/aiball`), for a reverse proxy
 * that forwards the prefix instead of stripping it (nginx, traefik without a
 * strip middleware). The daemon's routes stay at the root; a request under the
 * prefix has it removed before they see it.
 *
 * A request without the prefix is left alone, so a proxy that strips it
 * (`tailscale serve --set-path`) keeps working with the same setting.
 */
import type { NextFunction, Request, Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";
import { loadProviders, normalizeServePath } from "./providers.js";

/**
 * `server.base_path` from the global config, else the tailscale provider's
 * `path`, else none. Normalised: a leading `/`, no trailing one; root is none.
 */
export function resolveBasePath(): string | undefined {
    const p = globalConfigPath();
    if (existsSync(p)) {
        try {
            const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as { server?: { base_path?: unknown } };
            const own = normalizeServePath(raw.server?.base_path);
            if (own) return own;
        } catch {
            // An unreadable config serves at the root, as before.
        }
    }
    return loadProviders().tailscale?.path;
}

/**
 * `url` without the `base` prefix: `/aiball/api/x` → `/api/x`, `/aiball` →
 * `/`, `/aiball?x` → `/?x`. Any other url, `/aiballx` included, is returned as is.
 */
export function stripBasePath(url: string, base: string | undefined): string {
    if (!base || !url.startsWith(base)) return url;
    const rest = url.slice(base.length);
    if (rest === "") return "/";
    if (rest.startsWith("/")) return rest;
    if (rest.startsWith("?") || rest.startsWith("#")) return `/${rest}`;
    return url;
}

/** Express middleware removing `base` from each request's url. */
export function basePathMiddleware(base: string) {
    return (req: Request, _res: Response, next: NextFunction) => {
        req.url = stripBasePath(req.url, base);
        next();
    };
}

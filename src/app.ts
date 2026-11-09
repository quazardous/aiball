// #324: the aiball Express app factory, extracted from daemon.ts so the test
// stack can mount the REAL app in-process (no port/socket bind) and drive it
// through the business API. daemon.ts wraps this in the HTTP + UDS + WS servers;
// tests call createApp() + listen on an ephemeral port (or use it directly).
// No server bind, no side effects on import.
import { replicaNode, replicaProgress } from "./replica-node.js";
import { switchReadiness } from "./master-switch.js";
import { requestStatsMiddleware, requestStatsReport } from "./request-stats.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { UPLOADS_DIR } from "./paths.js";
import { api } from "./api.js";
import { serveUpload } from "./api/uploads.js";
import { errorCodeDefaults } from "./api/error-codes.js";
import { loadProxy, proxyMiddleware, proxyLandingHtml } from "./proxy.js";
import { mountVersionRoutes } from "./api/version-routes.js";
import { refuse } from "./api/_helpers.js";
import { basePathMiddleware, resolveBasePath } from "./base-path.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Locate the built frontend (`frontend/dist/index.html`), or null in dev. */
export function frontendDistDir(): string | null {
    const candidates = [
        resolve(__dirname, "..", "frontend", "dist"),
        resolve(__dirname, "..", "..", "frontend", "dist"),
    ];
    for (const c of candidates) {
        if (existsSync(join(c, "index.html"))) return c;
    }
    return null;
}

/**
 * #2215 — the last middleware on every app: an error nothing else handled ends
 * as JSON, never as Express's default HTML page, which printed the stack and
 * absolute paths into the response. An error carrying a 4xx status (a malformed
 * JSON body, a body over the size limit) keeps that status and its message;
 * anything else is a 500 whose details go to the daemon journal only.
 */
export function jsonErrorHandler(
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
): void {
    if (res.headersSent) return next(err);
    const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
    const raw = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : 500;
    if (raw >= 400 && raw < 500) {
        refuse(res, raw, typeof e.message === "string" ? e.message : "bad request");
        return;
    }
    console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
    refuse(res, 500, "internal error");
}

/**
 * Build the aiball Express app: JSON body parsing, the `/api` router, static
 * `/uploads` (content-addressed, long cache), and the built frontend with SPA
 * fallback when present. No server bind here — see daemon.ts (HTTP/UDS/WS) and
 * the test stack (in-process mount). #324.
 */
export function createApp(opts: { basePath?: string } = {}): express.Express {
    const app = express();
    // #1179 — served under a path by a proxy that forwards it: the routes below see the url without it.
    const base = "basePath" in opts ? opts.basePath : resolveBasePath();
    if (base) app.use(basePathMiddleware(base));
    // #2682 — per-route request counts and durations (GET /api/debug/requests).
    app.use(requestStatsMiddleware);
    // #3039 — every JSON refusal carries a code, the generic one of its status at least.
    app.use(errorCodeDefaults);
    app.get("/api/debug/requests", (_req, res) => res.json(requestStatsReport()));

    // #394: proxy mode. When a `proxy:` block is configured, this daemon is a
    // transparent relay to the remote — forward /api + /uploads (raw stream, no
    // body parsing, no local routers). The bus (`/bus`) is relayed on its own
    // (#3071): that is how the loops, the MCP server and the CLI reach A.
    const proxy = loadProxy();
    if (proxy) {
        // Local, never-relayed node probe: liveness of THIS daemon + whether
        // it's a proxy. Mounted BEFORE the relay so it isn't forwarded to the
        // remote (in proxy mode /api/health relays → reports the REMOTE, not us).
        // The tray reads it to show a `[proxy]` badge; details live on the page.
        // #4867 — with where this node's copy of the board stands.
        // #4874 — and whether it may take the board over now, or why not.
        app.get("/api/node", (_req, res) => res.json({ ok: true, proxy: true, upstream: proxy.url, replica: replicaProgress(), switch: switchReadiness(proxy) }));
        mountVersionRoutes(app);
        const fwd = proxyMiddleware(proxy);
        app.use("/api", fwd);
        // #4873 — an attachment this node holds is served from its copy (its
        // name is its content: it cannot be stale); one it lacks is relayed,
        // and taken from the master on the way.
        app.get("/uploads/:file", (req, res, next) => {
            const m = /^([0-9a-f]{64})\.([A-Za-z0-9]+)$/.exec(req.params.file);
            if (!m) { next(); return; }
            if (existsSync(join(UPLOADS_DIR, req.params.file))) { serveUpload(req, res); return; }
            replicaNode()?.keepFile(m[1]!, m[2]!);
            next();
        });
        app.use("/uploads", fwd);
        // #394 (8c7xut): the browser UI is degraded in proxy mode (it mirrors A),
        // so instead of the SPA serve a tiny "I'm a proxy of <url>" landing page.
        app.get(/^\/(?!api|ws|uploads).*/, (_req, res) => {
            res.type("html").send(proxyLandingHtml(proxy.url));
        });
        console.log(`aiball PROXY MODE → ${proxy.url}${proxy.strict ? " (strict: node token never injected)" : ""}`);
        app.use(jsonErrorHandler);
        return app;
    }

    app.use(express.json({ limit: "1mb" }));
    // Local node probe (public — before the bearer-auth'd router): liveness +
    // not-a-proxy. Mirrors the proxy-mode route so the tray uses one endpoint.
    app.get("/api/node", (_req, res) => res.json({ ok: true, proxy: false, upstream: null }));
    mountVersionRoutes(app);
    app.use("/api", api);

    // #841 — was `express.static(UPLOADS_DIR, ...)`. Custom handler so
    // the response carries the preserved original filename + an
    // inline/attachment disposition derived from the stored MIME.
    app.get(/^\/uploads\/[0-9a-f]{64}\.[A-Za-z0-9]+$/, serveUpload);
    app.head(/^\/uploads\/[0-9a-f]{64}\.[A-Za-z0-9]+$/, serveUpload);

    const dist = frontendDistDir();
    if (dist) {
        app.use(express.static(dist));
        app.get(/^\/(?!api|ws|uploads).*/, (_req, res) => {
            res.sendFile(join(dist, "index.html"));
        });
    } else {
        app.get("/", (_req, res) => {
            res.status(503).send(
                "Frontend not built yet. Run `npm --prefix frontend run build` " +
                    "or use the Vite dev server (`npm --prefix frontend run dev`).",
            );
        });
    }

    // #2215 — registered last, so it catches whatever the routes above let through.
    app.use(jsonErrorHandler);
    return app;
}

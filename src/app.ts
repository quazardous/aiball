// #324: the aiball Express app factory, extracted from daemon.ts so the test
// stack can mount the REAL app in-process (no port/socket bind) and drive it
// through the business API. daemon.ts wraps this in the HTTP + UDS + WS servers;
// tests call createApp() + listen on an ephemeral port (or use it directly).
// No server bind, no side effects on import.
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { api } from "./api.js";
import { UPLOADS_DIR } from "./paths.js";

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
 * Build the aiball Express app: JSON body parsing, the `/api` router, static
 * `/uploads` (content-addressed, long cache), and the built frontend with SPA
 * fallback when present. No server bind here — see daemon.ts (HTTP/UDS/WS) and
 * the test stack (in-process mount). #324.
 */
export function createApp(): express.Express {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api", api);

    // User-uploaded images (#B.76). Content-addressed → safe long max-age.
    app.use(
        "/uploads",
        express.static(UPLOADS_DIR, { maxAge: 86_400_000, immutable: true }),
    );

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

    return app;
}

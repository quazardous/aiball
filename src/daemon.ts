import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { api } from "./api.js";
import { attachWs } from "./ws.js";
import { getDb } from "./db.js";
import { AIBALL_HOME, UPLOADS_DIR, ensureDirs } from "./paths.js";
import { drainSpool, watchSpool } from "./spool.js";
import { listExpiredPostpones, setTicketPostpone, getMessage } from "./db.js";
import { broadcast as wsBroadcast } from "./ws.js";

/**
 * Snooze reveal cron (per #B.329). Every 60s, find tickets whose
 * `postponed_until` has passed, clear the field, and broadcast a
 * `message_edited` so the UI bounces them back into the open inbox.
 * The ticket was never actually closed (snooze ≠ close), so no
 * synthetic `ticket_reopened` event is needed — clearing the field
 * is enough.
 */
function revealExpiredPostpones(): void {
    try {
        const ids = listExpiredPostpones();
        for (const id of ids) {
            setTicketPostpone(id, null);
            const updated = getMessage(id);
            if (updated) wsBroadcast({ type: "message_edited", data: updated });
        }
        if (ids.length > 0) {
            console.log(`[postpone] revealed ${ids.length} ticket${ids.length === 1 ? "" : "s"}`);
        }
    } catch (e) {
        console.error("[postpone] reveal cron failed:", e);
    }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.AIBALL_HOST ?? "127.0.0.1";
const PORT = Number(process.env.AIBALL_PORT ?? 7777);

function frontendDistDir(): string | null {
    const candidates = [
        resolve(__dirname, "..", "frontend", "dist"),
        resolve(__dirname, "..", "..", "frontend", "dist"),
    ];
    for (const c of candidates) {
        if (existsSync(join(c, "index.html"))) return c;
    }
    return null;
}

function main(): void {
    ensureDirs(); // make sure UPLOADS_DIR etc. exist before serving them
    getDb(); // open + migrate

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api", api);

    // User-uploaded images (per #B.76). Served straight off disk — the
    // POST /api/uploads endpoint writes content-addressable files into
    // UPLOADS_DIR, the markdown body references them as /uploads/<hash>.<ext>.
    app.use(
        "/uploads",
        express.static(UPLOADS_DIR, {
            // 1 day cache — files are content-addressed so the hash is
            // the version; a long max-age is safe.
            maxAge: 86_400_000,
            immutable: true,
        }),
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

    const server = createServer(app);
    attachWs(server, "/ws");

    server.listen(PORT, HOST, () => {
        console.log(`aiball daemon listening on http://${HOST}:${PORT}`);
        console.log(`data dir: ${AIBALL_HOME}`);
        if (dist) console.log(`serving frontend from: ${dist}`);
        else console.log("no frontend build found (dev mode)");
        drainSpool();
        watchSpool();
        // Run the postpone reveal cron once at boot (in case the daemon
        // was down past a deadline), then every 60s after. 60s is fine
        // grain — users typically snooze for hours / days, not minutes.
        revealExpiredPostpones();
        setInterval(revealExpiredPostpones, 60_000).unref();
    });

    const shutdown = () => {
        console.log("shutting down...");
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();

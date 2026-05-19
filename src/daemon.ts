import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { api } from "./api.js";
import { attachWs } from "./ws.js";
import { getDb } from "./db.js";
import { AIBALL_HOME, UPLOADS_DIR, ensureDirs } from "./paths.js";
import { drainSpool, watchSpool } from "./spool.js";
import { listExpiredPostpones, setTicketPostpone, getMessage, backfillParentTicketRelations } from "./db.js";
import { broadcast as wsBroadcast } from "./ws.js";
import { checkSandboxPings } from "./sandbox/watcher.js";

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

// Unix-domain-socket listener for local-trust access (per #B.94 follow-up).
// Same-uid clients (CLI, MCP wrapper) connect here and bypass bearer auth —
// the OS already enforces the trust boundary via chmod 600. Set
// AIBALL_SOCK="" to disable. Defaults to $AIBALL_HOME/sock — except on
// Windows, where `net.createServer.listen(path)` maps onto Named Pipes
// (`\\.\pipe\…`), not AF_UNIX files. Trying to listen on a regular
// filesystem path under the user profile gets EACCES because node
// mangles it into an invalid pipe name. So Windows stays TCP-only by
// default; advanced users can still opt in by setting AIBALL_SOCK to a
// valid `\\.\pipe\…` path explicitly.
const SOCK_PATH = (() => {
    const v = process.env.AIBALL_SOCK;
    if (v === "") return null; // explicit opt-out
    if (v) return v;           // explicit opt-in (any platform)
    if (process.platform === "win32") return null; // Windows default: TCP-only
    return join(AIBALL_HOME, "sock");
})();

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
        // #B.123 phase B.3: backfill typed `depends_on` relations from
        // legacy parent_ticket_id rows. Idempotent — only inserts when
        // no relation event between the pair already exists.
        try {
            const n = backfillParentTicketRelations();
            if (n > 0) {
                console.log(`backfilled ${n} parent→depends_on relation(s)`);
            }
        } catch (e) {
            console.error("parent→depends_on backfill failed:", e);
        }
        // Run the postpone reveal cron once at boot (in case the daemon
        // was down past a deadline), then every 60s after. 60s is fine
        // grain — users typically snooze for hours / days, not minutes.
        revealExpiredPostpones();
        setInterval(revealExpiredPostpones, 60_000).unref();
        // Sandbox watcher: re-arms dead loop sandboxes when their agent
        // receives a new ping (#B.81 point 2). Set
        // AIBALL_SANDBOX_WATCHER=0 to disable.
        if (process.env.AIBALL_SANDBOX_WATCHER !== "0") {
            checkSandboxPings();
            setInterval(checkSandboxPings, 30_000).unref();
        }
    });

    // Side-car UDS server. Same Express app, but every incoming socket
    // is tagged so the auth middleware can recognize it as local-trust.
    let udsServer: ReturnType<typeof createServer> | null = null;
    if (SOCK_PATH) {
        try { unlinkSync(SOCK_PATH); } catch { /* not present */ }
        udsServer = createServer(app);
        udsServer.on("connection", (sock) => {
            // The auth middleware reads this flag on req.socket.
            (sock as unknown as { __aiballUds: boolean }).__aiballUds = true;
        });
        udsServer.listen(SOCK_PATH, () => {
            try { chmodSync(SOCK_PATH, 0o600); } catch { /* best effort */ }
            console.log(`aiball daemon listening on unix:${SOCK_PATH} (local-trust)`);
        });
    }

    const shutdown = () => {
        console.log("shutting down...");
        server.close(() => process.exit(0));
        if (udsServer) {
            udsServer.close();
            if (SOCK_PATH) {
                try { unlinkSync(SOCK_PATH); } catch { /* already gone */ }
            }
        }
        setTimeout(() => process.exit(1), 5000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main();

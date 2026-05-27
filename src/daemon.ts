import { createServer } from "node:http";
import { join } from "node:path";
import { unlinkSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";
import { createApp, frontendDistDir } from "./app.js";
import { DAEMON_PID_PATH } from "./paths.js";
import { attachWs } from "./ws.js";
import { getDb } from "./db.js";
import { AIBALL_HOME, ensureDirs } from "./paths.js";
import { drainSpool, watchSpool } from "./spool.js";
import { listExpiredPostpones, setTicketPostpone, getMessage, backfillParentTicketRelations } from "./db.js";
import { broadcast as wsBroadcast } from "./ws.js";
import { checkSandboxPings } from "./sandbox/watcher.js";
import { registerAutomationRuntime } from "./automation/runtime.js";
import { loadProxy, startProxyHeartbeat } from "./proxy.js";

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

/**
 * #407 — SIGUSR2 = reload config in place, no downtime (driven by `aiball
 * reload`). David `8q4pu5` chose to keep `kill -HUP` = restart (consistent with
 * the loop's kill-HUP #388 → see {@link hardRestart}), so the rarer hot-reload
 * moved off HUP onto USR2. Users don't signal USR2 directly — they run `aiball
 * reload`; USR2 is just its plumbing. SIGUSR1 is reserved by Node (inspector).
 *
 * aiball reads almost all config FRESH per request (`loadConfig()` re-reads
 * `.aiball.yaml`, `hotWindowSec()` re-reads the global yaml, settings/rules live
 * from the DB), so most config is already live without any reload. This handler
 * therefore (a) re-reads + validates the GLOBAL config so a broken edit surfaces
 * now and the effective values are logged as proof the reload ran, and (b) is the
 * single extension point for any future boot-cached config. It is wrapped so a
 * reload error can NEVER take the daemon down.
 */
function reloadConfig(): void {
    try {
        console.log("[sigusr2] reloading config…");
        const gp = globalConfigPath();
        let hotWin: unknown;
        try {
            const raw = parseYaml(readFileSync(gp, "utf8")) as { hot_window_sec?: unknown } | null;
            hotWin = raw?.hot_window_sec;
        } catch {
            // Missing/empty global config is the normal case — not an error.
        }
        console.log(`[sigusr2] config reloaded (most config is read fresh per request; global=${gp}, hot_window_sec=${hotWin ?? "default"})`);
    } catch (e) {
        console.error("[sigusr2] config reload failed (daemon stays up):", e);
    }
}

/**
 * #407 — SIGHUP = HARD restart, **identical to the loop's kill-HUP** (#388, which
 * self-restarts its timer). David `8q4pu5` ("Pourquoi pas hup ? je comprends
 * pas") + `Allons-y` settled on one consistent signal across loop and daemon:
 * `kill -HUP <daemon>` = restart, for the cases the soft reload can't cover —
 * schema migrations, env changes, code that didn't hot-reload, socket rebind.
 * (The rarer hot config reload lives on USR2 via `aiball reload`.)
 *
 * It MUST go through the service supervisor, not a self-exit: the daemon runs
 * under `tsx watch`, and `tsx watch` only relaunches on file changes — NOT on
 * process exit (verified) — so `process.exit()` here would leave aiball DOWN.
 * `systemctl --user restart aiball` instead bounces the whole service tree
 * (npm → tsx watch → fresh daemon), re-running migrations + reloading all code.
 * Spawned detached + unref'd so it survives the SIGTERM the supervisor sends us.
 */
function hardRestart(): void {
    try {
        console.log("[sighup] hard restart requested — delegating to the service supervisor…");
        const child = spawn("systemctl", ["--user", "restart", "aiball"], {
            detached: true,
            stdio: "ignore",
        });
        child.on("error", (e) => console.error("[sighup] hard restart spawn failed (daemon stays up):", e));
        child.unref();
    } catch (e) {
        console.error("[sighup] hard restart failed (daemon stays up):", e);
    }
}

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

function main(): void {
    ensureDirs(); // make sure UPLOADS_DIR etc. exist before serving them
    getDb(); // open + migrate

    // #457 slice 2 : attach the automation engine to the lifecycle bus once
    // the DB is up. Idempotent — under `tsx watch` daemon code reloads but
    // the process restarts, so a single registration per process is fine.
    registerAutomationRuntime();

    // #407: publish our pid so `aiball reload` can target THIS process for a
    // SIGHUP config-reload. Under `tsx watch` the daemon runs in a child whose
    // pid changes on every code reload, so the pidfile is the reliable handle.
    try { writeFileSync(DAEMON_PID_PATH, String(process.pid)); } catch { /* best effort */ }

    // #324: app building lives in src/app.ts (createApp) so the test stack can
    // mount the same app in-process. daemon.ts only wraps it in the servers.
    const app = createApp();
    const dist = frontendDistDir();

    const server = createServer(app);
    attachWs(server, "/ws");

    server.listen(PORT, HOST, () => {
        console.log(`aiball daemon listening on http://${HOST}:${PORT}`);
        console.log(`data dir: ${AIBALL_HOME}`);
        if (dist) console.log(`serving frontend from: ${dist}`);
        else console.log("no frontend build found (dev mode)");
        drainSpool();
        watchSpool();
        // #271: backfill typed `child_of` lineage relations from legacy
        // parent_ticket_id rows (upgrading the old #B.123 `depends_on`
        // backfill). Idempotent — settled re-runs insert nothing.
        try {
            const n = backfillParentTicketRelations();
            if (n > 0) {
                console.log(`backfilled ${n} parent→child_of relation(s)`);
            }
        } catch (e) {
            console.error("parent→child_of backfill failed:", e);
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
        // #502 — en mode proxy, on tape un heartbeat upstream toutes les 30s
        // pour que le Nodes panel puisse afficher une vraie pastille up/down
        // (le middleware auth bumpe `tokens.last_used_at` au passage, c'est ce
        // timestamp qui dérive la couleur côté UI). Pas-op en mode normal.
        const px = loadProxy();
        if (px) {
            startProxyHeartbeat(px);
            console.log(`proxy heartbeat → ${px.url}/api/proxy/heartbeat every 30s`);
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
        try { unlinkSync(DAEMON_PID_PATH); } catch { /* already gone */ }
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
    // #407: HUP = hard restart, identical to the loop's kill-HUP (david 8q4pu5).
    process.on("SIGHUP", hardRestart);
    // #407: USR2 = soft config reload, no downtime (driven by `aiball reload`).
    process.on("SIGUSR2", reloadConfig);
}

main();

/**
 * #2084 / #2089 — restarting this daemon through whatever supervises it.
 *
 * A second caller needed this once pairing became automatic: a granted request
 * has to come back as a relay, and proxy mode is decided in `createApp()` —
 * the whole application is replaced by a forwarder, which cannot be swapped in
 * place. A restart is the mechanism, not an omission.
 *
 * ## Two platforms, two mechanisms, one rule
 *
 * On Linux the supervisor takes orders: `systemctl --user restart aiball`. It
 * works from any process, and a self-exit would NOT be relaunched under
 * `Restart=on-failure` — that is how you turn a daemon off, not restart it.
 *
 * Windows has no such command, but it has a watchdog: the tray polls the
 * daemon's health every five seconds and starts it again when nothing answers
 * (`bin/aiball-tray.ps1`). So there, **stopping the daemon IS restarting it**.
 *
 * The rule that makes that safe is the same on both: never stop the daemon
 * without evidence that something will bring it back. On Windows that evidence
 * is a fresh heartbeat written by the tray; without it we refuse and say so,
 * because a portable or dev daemon has no watchdog and stopping it would just
 * turn aiball off — trading a manual step for an outage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIBALL_HOME, DAEMON_PID_PATH } from "./paths.js";

/** Where the tray says it is alive. Same directory the daemon calls home, so
 *  the two agree without either being told. */
export const TRAY_HEARTBEAT_PATH = join(AIBALL_HOME, "tray.alive");

/** The tray ticks every 5s. Six ticks of slack: a laptop waking from sleep,
 *  or a tray briefly starved, must not read as absent. */
export const TRAY_HEARTBEAT_STALE_MS = 30_000;

/**
 * Is a watchdog going to bring the daemon back? PURE, because this is the
 * decision that matters: say yes wrongly and stopping the daemon turns aiball
 * off until someone notices.
 *
 * Anything unreadable, undated or old is a no. The safe answer is the one that
 * leaves a running daemon running.
 */
export function trayIsWatching(heartbeat: string | null, nowMs: number): boolean {
    if (!heartbeat) return false;
    const t = Date.parse(heartbeat.trim());
    if (!Number.isFinite(t)) return false;
    return nowMs - t < TRAY_HEARTBEAT_STALE_MS && t - nowMs < TRAY_HEARTBEAT_STALE_MS;
}

function readTrayHeartbeat(): string | null {
    try {
        return readFileSync(TRAY_HEARTBEAT_PATH, "utf8");
    } catch {
        return null;
    }
}

/** Stop the running daemon so the watchdog starts it again. Returns false when
 *  there is nothing to stop — the pidfile is how a process that is NOT the
 *  daemon reaches it (`proxy pair` runs in its own process). */
function stopDaemonForWatchdog(selfIsDaemon: boolean): boolean {
    if (selfIsDaemon) {
        // Leave the caller a moment to flush its log line and finish the
        // response it is in the middle of, then go.
        setTimeout(() => process.exit(1), 250).unref?.();
        return true;
    }
    try {
        const pid = Number.parseInt(readFileSync(DAEMON_PID_PATH, "utf8").trim(), 10);
        if (!Number.isInteger(pid) || pid <= 0) return false;
        process.kill(pid);
        return true;
    } catch {
        return false;
    }
}

/**
 * Why a restart was refused, in words the person in front of it can act on.
 *
 * #2089 follow-up — the first real Windows pairing hit exactly this and the
 * message did not say the one thing that mattered: the tray reads its script at
 * launch, so a tray started before the upgrade is still running the old one and
 * writes no heartbeat. "Nothing supervises this daemon" is true and useless;
 * "quit and relaunch the tray" is the action.
 */
export function supervisorHint(): string {
    if (process.platform === "win32") {
        return "no live tray heartbeat at " + TRAY_HEARTBEAT_PATH + ". The tray supervises the "
            + "daemon here, but it reads its script when it starts — quit it from the tray icon "
            + "and launch it again, then retry. Without a tray, restart the daemon by hand.";
    }
    return "could not reach a systemd user service. Restart the daemon the way you launched it.";
}

/**
 * Restart the daemon. Returns false when no supervisor could be reached, so the
 * caller says what to do by hand — `supervisorHint()` above is that wording.
 *
 * `selfIsDaemon` says whether the caller IS the daemon process. It changes
 * nothing on Linux; on Windows it is the difference between exiting and
 * reaching for the pidfile.
 */
export function restartViaSupervisor(opts: { selfIsDaemon?: boolean } = {}): boolean {
    if (process.platform === "win32") {
        if (!trayIsWatching(readTrayHeartbeat(), Date.now())) return false;
        return stopDaemonForWatchdog(opts.selfIsDaemon === true);
    }
    const r = spawnSync("systemctl", ["--user", "restart", "aiball"], { stdio: "inherit" });
    return !r.error && r.status === 0;
}

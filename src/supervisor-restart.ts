/**
 * #2084 — restarting this daemon through its supervisor.
 *
 * Extracted from `aiball restart` because a second caller now needs it: once a
 * pairing is granted, the node has to come back as a relay, and proxy mode is
 * decided in `createApp()` — the whole application is replaced by a forwarder,
 * which is not something you can swap in place. A restart is the mechanism, not
 * an omission.
 *
 * It goes through the supervisor rather than exiting: a clean SIGTERM would not
 * be relaunched under `Restart=on-failure`, so a self-exit is how you turn a
 * daemon off, not how you restart it.
 */
import { spawnSync } from "node:child_process";

/**
 * Canonical deploy = a systemd user service. Returns false when there is no
 * supervisor to ask — a dev checkout, Windows, a hand-launched daemon — so the
 * caller can say what to do by hand instead of pretending it worked.
 *
 * #2089 — WINDOWS IS NOT COVERED, and that is a real gap rather than a detail:
 * on a Windows node this returns false, so the automatic restart that removes
 * the pairing's third step simply does not happen there. Windows has its own
 * supervisors (the tray, which relaunches the daemon if it dies; a scheduled
 * task or a service with restart-on-failure), but reaching them means the
 * daemon exiting rather than asking anyone — which is safe under a supervisor
 * and destroys a dev instance without one. That distinction is what the ticket
 * is for; guessing it here would be worse than the honest false.
 */
export function restartViaSupervisor(): boolean {
    const r = spawnSync("systemctl", ["--user", "restart", "aiball"], { stdio: "inherit" });
    return !r.error && r.status === 0;
}

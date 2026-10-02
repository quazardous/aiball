/**
 * #3333 / #3483 — a process that must outlive the aiball service goes in a
 * systemd scope of its own. Under systemd, `systemctl --user restart aiball`
 * sends SIGTERM to every process in the service's cgroup, whoever spawned them:
 * the session hosts (#3333), then the loop kernels the daemon's `session.start`
 * launched (#3483), which took that SIGTERM for "stop the loop" and stopped
 * their Claude with them. `systemd-run --scope` moves itself into the scope,
 * then becomes the command (exec): the pid is the command's.
 */
import { spawnSync } from "node:child_process";

export interface Scoped {
    cmd: string;
    /** systemd-run's arguments, ending with `--`: the command follows. */
    args: string[];
    env: Record<string, string>;
}

/**
 * The `systemd-run` that puts a command in a scope named `<prefix>-<name>-<time>`.
 * Null outside a systemd unit (no `INVOCATION_ID`: nothing restarts it), off
 * Linux, or without systemd-run.
 */
export function ownScope(prefix: string, name: string, env: Record<string, string>, parentEnv: NodeJS.ProcessEnv = process.env, hasSystemdRun: () => boolean = systemdRunFound): Scoped | null {
    if (process.platform !== "linux" || !parentEnv.INVOCATION_ID || !hasSystemdRun()) return null;
    const unit = `${prefix}-${name.replace(/[^A-Za-z0-9_.-]/g, "_")}-${Date.now()}`;
    // systemd-run reaches the user manager through these; the command's own
    // environment may not carry them.
    const bus: Record<string, string> = {};
    for (const k of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
        const v = env[k] ?? parentEnv[k];
        if (v) bus[k] = v;
    }
    return { cmd: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", `--unit=${unit}`, "--"], env: { ...env, ...bus } };
}

/**
 * Whether the user manager starts a scope at all, tried once with `true`: a
 * caller that cannot see its command fail afterwards (a detached spawn) asks
 * first, and starts without a scope when it does not.
 */
export function scopeStarts(scope: Scoped): boolean {
    const args = scope.args.filter((a) => !a.startsWith("--unit="));
    return spawnSync(scope.cmd, [...args, "true"], { env: scope.env, stdio: "ignore", timeout: 5000 }).status === 0;
}

let systemdRun: boolean | null = null;
function systemdRunFound(): boolean {
    systemdRun ??= spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0;
    return systemdRun;
}

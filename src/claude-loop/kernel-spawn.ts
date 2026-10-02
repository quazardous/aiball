/**
 * The detached kernel (kernel.ts), as `start` and `reload` spawn it: a login
 * bash that sources the loop's env files, then becomes tsx. Logs into loop.log;
 * its pid goes to loop.pid.
 *
 * #3483 — under systemd it goes in a scope of its own (systemd-scope.ts). A
 * `session.start` runs `claude-loop start` from the daemon, so the kernel was
 * born in the aiball service's cgroup: `aiball restart` sent it SIGTERM, which
 * a kernel takes for "stop the loop", Claude with it. In its own scope it only
 * loses the daemon for a few seconds and reconnects. When the user manager
 * does not start a scope, the kernel starts as before.
 */
import { spawn } from "node:child_process";
import { openSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ownScope, scopeStarts, type Scoped } from "../systemd-scope.js";
import { resolveBashCmd } from "./resolve-bash.js";
import { envLocalPath, envPath, loopLogPath, loopPidPath } from "./state.js";

function shQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The scope for a kernel of state dir `sd`, when one starts; null otherwise. */
export function kernelScope(sd: string, env: Record<string, string>, parentEnv: NodeJS.ProcessEnv = process.env, starts: (s: Scoped) => boolean = scopeStarts, hasSystemdRun?: () => boolean): Scoped | null {
    const scope = ownScope("aiball-kernel", basename(sd), env, parentEnv, hasSystemdRun);
    return scope && starts(scope) ? scope : null;
}

/**
 * Spawn the kernel of `sd`, detached. `tsx` is the tsx binary as a shell word
 * (already quoted). Returns the pid written to loop.pid.
 */
export function spawnKernel(sd: string, root: string, tsx: string, env: NodeJS.ProcessEnv): number | undefined {
    const logFd = openSync(loopLogPath(sd), "a");
    const loopScript = join(root, "src/claude-loop/kernel.ts");
    // A bare `bash` here reaches the WSL launcher from a PowerShell-launched
    // `claude-loop`, which opens a console, fails to source a Windows path, and
    // dies — leaving loop.log EMPTY (#1584). tsx by its absolute path, so the
    // kernel can be respawned from any cwd (#B.228). env.local re-sourced: the
    // debug-session overrides survive a reload (#991).
    const bashArgs = [
        "-lc",
        `source ${shQuote(envPath(sd))}; [ -f ${shQuote(envLocalPath(sd))} ] && source ${shQuote(envLocalPath(sd))}; exec ${tsx} ${shQuote(loopScript)}`,
    ];
    const plainEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
    const scope = kernelScope(sd, plainEnv);
    const child = scope
        ? spawn(scope.cmd, [...scope.args, resolveBashCmd(), ...bashArgs], { detached: true, stdio: ["ignore", logFd, logFd], env: scope.env })
        : spawn(resolveBashCmd(), bashArgs, { detached: true, stdio: ["ignore", logFd, logFd], env: plainEnv });
    child.unref();
    writeFileSync(loopPidPath(sd), String(child.pid) + "\n");
    return child.pid;
}

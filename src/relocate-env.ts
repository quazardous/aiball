/**
 * The real machine `relocate` and `project rename-all` read (#2468): Claude's
 * state under the home, the loops, and the processes and their cwd from /proc.
 * #3765 — out of the CLI, so the daemon plans a rename the same way.
 */
import { claudeConfigDir } from "./claude-config-dir.js";
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelocateEnv } from "./relocate.js";

/** Running processes and their cwd, from /proc — null where there is no /proc. */
function procCwds(): Array<{ pid: number; cwd: string; cmd: string }> | null {
    if (process.platform !== "linux" || !existsSync("/proc")) return null;
    // This process and the ones that launched it are exempt: running
    // `aiball relocate . ../elsewhere` from inside the folder must not refuse
    // itself. Any other process there still blocks.
    const self = new Set<number>();
    for (let pid = process.pid; pid > 1 && !self.has(pid);) {
        self.add(pid);
        try {
            pid = Number(readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) \S+ /, "").split(" ")[0]);
        } catch { break; }
    }
    const out: Array<{ pid: number; cwd: string; cmd: string }> = [];
    for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (self.has(pid)) continue;
        try {
            const cwd = readlinkSync(`/proc/${name}/cwd`);
            const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ").slice(0, 120);
            out.push({ pid, cwd, cmd });
        } catch { /* gone, or not ours */ }
    }
    return out;
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** The real machine: home, Claude's state, the loops, /proc. */
export function relocateEnv(scan: string[], cwd?: string): RelocateEnv {
    const home = homedir();
    // CLAUDE_CONFIG_DIR moves both: the state dir and the .claude.json inside it.
    // #4120 — the project's own one when it names one (`claude.config_dir`).
    const claude = claudeConfigDir(cwd ?? null);
    return {
        claudeDir: claude.dir,
        claudeJson: claude.json,
        loopRoot: process.env.CLAUDE_LOOP_STATE_ROOT ?? join(home, ".claude-loop"),
        scanRoots: [join(home, ".local", "bin"), join(home, "bin"), ...scan],
        processCwds: procCwds,
        pidAlive,
    };
}

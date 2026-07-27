/**
 * Shared "is this command on PATH?" probe. Single source of truth for the
 * doctor checks (`aiball check`, `claude-loop check`) and the claude-loop
 * PTY-proxy launch (#269) so the check reports exactly what the launch
 * will decide. `stdio:"ignore"` keeps the probe quiet.
 *
 * `command -v` is a POSIX shell builtin (claude-loop is posix-centric —
 * tmux), but it does NOT exist in cmd.exe, so on Windows it returned false
 * for EVERYTHING — even `node`. Harmless today (the only Windows callers are
 * gated behind `process.platform` / X11 env that's unset on Windows), but a
 * footgun for any future caller. Use the OS lookup tool per platform:
 * `where` on Windows, `command -v` elsewhere — matching `need()` in
 * claude-loop's cli.ts.
 */
import { spawnSync } from "node:child_process";

export function commandExists(cmd: string): boolean {
    if (process.platform === "win32") {
        return spawnSync("where", [cmd], { stdio: "ignore" }).status === 0;
    }
    return spawnSync("command", ["-v", cmd], { shell: true, stdio: "ignore" }).status === 0;
}

// =====================================================================
// Prerequisites a package cannot carry (#1567 phase 3)
// =====================================================================

/**
 * Things aiball needs that live outside npm's reach: a terminal multiplexer, a
 * Python interpreter, a Rust toolchain. Shipping a package makes these MORE
 * important, not less — `npm i -g aiball` succeeds whether or not tmux exists,
 * so the first sign of trouble would otherwise be a loop that won't start.
 *
 * `required: false` means aiball still works without it, in a named degraded
 * mode — the check says which, instead of leaving the user to guess whether a
 * missing dot matters.
 */
export interface Prereq {
    /** Command probed on PATH. */
    cmd: string;
    /** What breaks, or degrades, without it. */
    powers: string;
    /** What you lose. Empty when the thing simply does not run. */
    degraded: string;
    required: boolean;
    /** Package name per manager, when it differs from `cmd`. */
    packages?: Record<string, string>;
}

export const PREREQS: readonly Prereq[] = [
    {
        cmd: "tmux",
        powers: "claude-loop (every loop runs in a tmux session)",
        degraded: "",
        required: true,
    },
    {
        cmd: "python3",
        powers: "the claude-loop PTY proxy — live human-typing detection",
        degraded: "the loop falls back to direct launch + pane-diff (idle-only)",
        required: false,
        packages: { apk: "python3", brew: "python", pacman: "python" },
    },
    {
        cmd: "cargo",
        powers: "building cl-pty-proxy, the Rust PTY proxy",
        degraded: "the loop uses the Python proxy instead",
        required: false,
        packages: { apt: "cargo", dnf: "cargo", pacman: "rust", zypper: "cargo", apk: "cargo", brew: "rust" },
    },
];

interface Manager {
    id: string;
    probe: string;
    install: (pkg: string) => string;
}

// Ordered by specificity, not popularity: a box with both `apt-get` and `brew`
// is a Linux box where someone also installed Homebrew, so the native manager
// is the right suggestion.
const MANAGERS: readonly Manager[] = [
    { id: "apt", probe: "apt-get", install: (p) => `sudo apt-get install ${p}` },
    { id: "dnf", probe: "dnf", install: (p) => `sudo dnf install ${p}` },
    { id: "pacman", probe: "pacman", install: (p) => `sudo pacman -S ${p}` },
    { id: "zypper", probe: "zypper", install: (p) => `sudo zypper install ${p}` },
    { id: "apk", probe: "apk", install: (p) => `sudo apk add ${p}` },
    { id: "brew", probe: "brew", install: (p) => `brew install ${p}` },
];

let cachedManager: Manager | null | undefined;

function detectManager(): Manager | null {
    if (cachedManager !== undefined) return cachedManager;
    cachedManager = MANAGERS.find((m) => commandExists(m.probe)) ?? null;
    return cachedManager;
}

export interface PrereqStatus extends Prereq {
    present: boolean;
    /** Ready-to-paste install command, or null when we can't name one. */
    install: string | null;
}

/**
 * Probe every prerequisite and pair each miss with the command that fixes it on
 * THIS machine. Naming the fix is the whole point: "python3: MISSING" makes the
 * user go looking, `sudo dnf install python3` does not.
 */
export function checkPrereqs(): PrereqStatus[] {
    const mgr = detectManager();
    return PREREQS.map((p) => {
        const present = commandExists(p.cmd);
        const pkg = (mgr && p.packages?.[mgr.id]) ?? p.cmd;
        return { ...p, present, install: present || !mgr ? null : mgr.install(pkg) };
    });
}

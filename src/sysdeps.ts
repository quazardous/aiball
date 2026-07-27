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
    /**
     * Other commands that satisfy the same need. `psmux` ships a `tmux` alias,
     * so a box carrying either one can run a loop — probing only the canonical
     * name would report a miss on a working install.
     */
    altCmds?: readonly string[];
    /** What breaks, or degrades, without it. */
    powers: string;
    /** What you lose. Empty when the thing simply does not run. */
    degraded: string;
    required: boolean;
    /** Package name per manager, when it differs from `cmd`. */
    packages?: Record<string, string>;
}

/**
 * The prerequisites differ per platform because the runtime does (#1571). On
 * Windows the multiplexer is psmux, the PTY proxy is the Rust ConPTY one, and
 * there is no Python proxy at all — reporting `python3: missing` there would
 * name a degradation that cannot happen. The Windows list mirrors what
 * `install.ps1` already provisions, so `check` and the installer agree.
 */
const POSIX_PREREQS: readonly Prereq[] = [
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

const WIN32_PREREQS: readonly Prereq[] = [
    {
        cmd: "psmux",
        // psmux ships a `tmux` alias, which is why claude-loop's default
        // MUX_CMD=tmux resolves on Windows (install.ps1 accepts either).
        altCmds: ["tmux"],
        powers: "claude-loop (every loop runs in a psmux session)",
        degraded: "",
        required: true,
        packages: { winget: "psmux" },
    },
    {
        // claude-loop spawns `bash -lc 'source env; exec claude'`. winget's
        // Git.Git puts git.exe on PATH via Git\cmd but NOT bash.exe, which
        // lives in Git\bin — install.ps1 patches the user PATH for exactly
        // this reason, so a miss here is worth naming explicitly.
        cmd: "bash",
        powers: "claude-loop's inner `bash -lc` launch (Git Bash provides it)",
        degraded: "",
        required: true,
        packages: { winget: "Git.Git", scoop: "git", choco: "git" },
    },
    {
        cmd: "cargo",
        powers: "building cl-pty-proxy.exe, the Rust ConPTY proxy",
        // No Python proxy on Windows — the fallback is a direct launch with
        // pane-diff detection, which only sees an idle pane.
        degraded: "the loop falls back to direct launch + pane-diff (idle-only)",
        required: false,
        packages: { winget: "Rustlang.Rustup", scoop: "rustup", choco: "rust" },
    },
];

export const PREREQS: readonly Prereq[] =
    process.platform === "win32" ? WIN32_PREREQS : POSIX_PREREQS;

interface Manager {
    id: string;
    probe: string;
    install: (pkg: string) => string;
}

// Ordered by specificity, not popularity: a box with both `apt-get` and `brew`
// is a Linux box where someone also installed Homebrew, so the native manager
// is the right suggestion. The Windows managers sit at the end because their
// probes are mutually exclusive with the POSIX ones anyway — winget first, as
// it ships with the OS and is what install.ps1 already drives.
const MANAGERS: readonly Manager[] = [
    { id: "apt", probe: "apt-get", install: (p) => `sudo apt-get install ${p}` },
    { id: "dnf", probe: "dnf", install: (p) => `sudo dnf install ${p}` },
    { id: "pacman", probe: "pacman", install: (p) => `sudo pacman -S ${p}` },
    { id: "zypper", probe: "zypper", install: (p) => `sudo zypper install ${p}` },
    { id: "apk", probe: "apk", install: (p) => `sudo apk add ${p}` },
    { id: "brew", probe: "brew", install: (p) => `brew install ${p}` },
    {
        id: "winget",
        probe: "winget",
        install: (p) =>
            `winget install ${p} --silent --accept-source-agreements --accept-package-agreements`,
    },
    { id: "scoop", probe: "scoop", install: (p) => `scoop install ${p}` },
    { id: "choco", probe: "choco", install: (p) => `choco install ${p} -y` },
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
        // Any of the accepted names counts: psmux and its tmux alias satisfy
        // the same requirement, and a loop runs on either.
        const present =
            commandExists(p.cmd) || (p.altCmds ?? []).some((alt) => commandExists(alt));
        const pkg = (mgr && p.packages?.[mgr.id]) ?? p.cmd;
        return { ...p, present, install: present || !mgr ? null : mgr.install(pkg) };
    });
}

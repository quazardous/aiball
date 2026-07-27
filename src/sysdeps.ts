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

/** Where the OS resolves `cmd`, or null when it isn't on PATH. */
export function commandPath(cmd: string): string | null {
    const r = process.platform === "win32"
        ? spawnSync("where", [cmd], { encoding: "utf8" })
        : spawnSync("command", ["-v", cmd], { shell: true, encoding: "utf8" });
    if (r.status !== 0) return null;
    const first = (r.stdout ?? "").split(/\r?\n/)[0]?.trim();
    return first || null;
}

// =====================================================================
// Installed commands, end to end (#1583)
// =====================================================================

export interface ShimStatus {
    cmd: string;
    /** What the OS resolves the name to; null when it isn't on PATH. */
    path: string | null;
    /** Did invoking it actually produce a working command? */
    works: boolean;
    detail: string;
}

/**
 * Probe the installed commands by RUNNING them, not by looking at paths.
 *
 * #1583 — deleting the versioned `bin/*.cmd` left every Windows box whose
 * shims were written by the older installer pointing at files that no longer
 * exist. The shim itself was still there, so a path-existence check would have
 * reported the broken machine as healthy: the failure is one level deeper, in
 * what the shim hands off to. A dangling POSIX symlink fails at the other
 * level. Executing the command is the only probe that catches both — and it
 * covers the whole chain (shim → target → node → tsx) rather than one link.
 *
 * `aiball-mcp` is a stdio server with no `--version`, so asking for one would
 * hang waiting on input. It gets an immediate EOF instead: a healthy server
 * starts, sees the closed stdin and exits cleanly.
 *
 * Reports, never repairs — the fix differs per install mode and belongs to
 * whoever owns the box.
 */
export function checkShims(timeoutMs = 15_000): ShimStatus[] {
    /**
     * Run an installed command the way the OS actually would.
     *
     * On Windows neither obvious form works: `spawnSync("aiball", …)` fails
     * with ENOENT because CreateProcess does no PATHEXT resolution — the name
     * has no extension — and spawning the RESOLVED `.cmd` fails too, since Node
     * refuses `.cmd`/`.bat` without a shell (the CVE-2024-27980 mitigation). So
     * the probe reported every Windows box as broken, whatever its actual
     * state, and told the user to re-run the installer for nothing. Exactly the
     * shape `commandExists` above was already fixed for.
     *
     * A shell invocation is therefore the only form that runs a shim on
     * Windows. The command line is assembled here rather than passed as an args
     * array with `shell: true`, which concatenates without escaping (DEP0190) —
     * safe with these fixed literals, but not a habit worth keeping.
     */
    const run = (cmd: string, args: string[], input?: string) => {
        if (process.platform === "win32") {
            return spawnSync([cmd, ...args].join(" "), {
                encoding: "utf8", timeout: timeoutMs, input, shell: true,
            });
        }
        return spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, input });
    };

    const probe = (cmd: string, args: string[], input?: string): ShimStatus => {
        const path = commandPath(cmd);
        if (!path) {
            return { cmd, path: null, works: false, detail: "not on PATH" };
        }
        const r = run(cmd, args, input);
        if (r.status === 0) return { cmd, path, works: true, detail: path };
        // The shim resolved but running it failed — the classic shape is a
        // launcher pointing at a target that has since moved or been deleted.
        const why = r.error?.message
            ?? (r.stderr ?? "").split(/\r?\n/).find((l) => l.trim())
            ?? `exited ${r.status ?? "on a signal"}`;
        return { cmd, path, works: false, detail: `${path} — ${why.trim()}` };
    };
    return [
        probe("aiball", ["--version"]),
        probe("claude-loop", ["--version"]),
        probe("aiball-mcp", [], ""),
    ];
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

/**
 * The prerequisite list for a given platform. Pure and explicit, for the same
 * reason `renderUnit` builds posix paths and `renderDaemonLauncherCmd` builds
 * win32 ones whatever host runs them: a list that can only be read on the
 * platform it describes can only be asserted there, and the Windows lane is
 * precisely the one we do not want to depend on to catch a mistake in the
 * Windows list.
 */
export function prereqsFor(platform: NodeJS.Platform = process.platform): readonly Prereq[] {
    return platform === "win32" ? WIN32_PREREQS : POSIX_PREREQS;
}

/** This host's list — what `checkPrereqs` probes. */
export const PREREQS: readonly Prereq[] = prereqsFor();

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

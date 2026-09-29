/**
 * #2586 — how this aiball was installed, as the installer recorded it, and the
 * command that updates it without changing the way it was installed.
 *
 * `install.sh` has three modes and `install.ps1` mirrors them:
 *   - `release` — the latest tag of a clone, copied into the install dir;
 *   - `edge`    — a checkout copied as it was (`--edge` / `-Edge`);
 *   - `dev`     — the install dir is a symlink to a checkout (`--symlink`).
 * Nothing recorded which one was used, so the installers now write
 * `<config dir>/install.json`. An install older than that is recognised from
 * its layout when it runs from a git checkout (a dev install: the checkout is
 * the install), and reads `unknown` otherwise.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globalConfigPath } from "./autopoll/config.js";

export type InstallMode = "release" | "edge" | "dev" | "unknown";

export interface InstallInfo {
    mode: InstallMode;
    /** The clone or checkout the install came from. */
    source: string | null;
    /** The installer's own flags worth repeating (port, host, …), as typed. */
    flags: string[];
    platform: "posix" | "windows";
    /** Not recorded by an installer: worked out from where this code runs. */
    inferred?: true;
}

export function installInfoPath(): string {
    return join(dirname(globalConfigPath()), "install.json");
}

/** Parse the recorded file; anything unreadable is `unknown`. */
export function parseInstallInfo(text: string | null, platform: NodeJS.Platform = process.platform): InstallInfo {
    const unknown: InstallInfo = { mode: "unknown", source: null, flags: [], platform: platform === "win32" ? "windows" : "posix" };
    if (!text) return unknown;
    try {
        // install.ps1 on Windows PowerShell 5.1 writes UTF-8 with a BOM.
        const j = JSON.parse(text.replace(/^\uFEFF/, "")) as { mode?: unknown; source?: unknown; flags?: unknown };
        const mode = j.mode === "release" || j.mode === "edge" || j.mode === "dev" ? j.mode : "unknown";
        return {
            ...unknown,
            mode,
            source: typeof j.source === "string" && j.source ? j.source : null,
            flags: Array.isArray(j.flags) ? j.flags.filter((f): f is string => typeof f === "string") : [],
        };
    } catch {
        return unknown;
    }
}

export function readInstallInfo(path = installInfoPath()): InstallInfo {
    let text: string | null = null;
    try { text = readFileSync(path, "utf8"); } catch { /* not recorded */ }
    const info = parseInstallInfo(text);
    return info.mode === "unknown" && !text ? (inferInstallInfo() ?? info) : info;
}

/** src/install-info.ts -> up 1 = the root this code runs from. */
function runningRoot(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * An install with no record, recognised from its layout. Running from a git
 * checkout means a dev install (`--symlink` / `-Symlink`, whose install dir
 * links to the checkout, or `-Minimal`, which runs it in place): the checkout
 * is what gets updated. A copy carries no `.git` and is not guessed at.
 */
export function inferInstallInfo(root: string = runningRoot(), platform: NodeJS.Platform = process.platform): InstallInfo | null {
    let real: string;
    try { real = realpathSync(root); } catch { return null; }
    if (!existsSync(join(real, ".git"))) return null;
    return { mode: "dev", source: real, flags: [], platform: platform === "win32" ? "windows" : "posix", inferred: true };
}

function shq(s: string): string {
    return /^[\w./:@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function psq(s: string): string {
    return /^[\w.:\\/@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

export interface UpdateStep {
    /** Run in the install's source directory. */
    argv: string[];
    /** How the step reads in the command shown to a human, when it differs. */
    display?: string;
    /** The daemon restart: on Windows the tray does it (it owns the daemon). */
    restart?: boolean;
}

/**
 * #2588 — the steps that update this install the way it was installed, run by
 * `aiball update` and shown by `aiball version`: one list, so what is shown is
 * what runs. Null without a recorded source.
 *
 * `install.sh` ships the latest tag REACHABLE from the clone's HEAD, so fetching
 * tags is not enough: the clone is pulled first. `install.ps1` copies the
 * checkout as it is (`edge`). A `dev` install runs the checkout itself: pull,
 * dependencies, frontend, restart.
 */
export function updateSteps(info: InstallInfo): UpdateStep[] | null {
    if (!info.source) return null;
    const win = info.platform === "windows";
    const pull: UpdateStep = { argv: ["git", "pull", "--ff-only", "--tags"] };
    if (info.mode === "dev") {
        return [
            pull,
            { argv: ["npm", "install"] },
            { argv: ["npm", "--prefix", "frontend", "run", "build"] },
            { argv: ["aiball", "restart"], restart: true },
        ];
    }
    const flags = [...(info.mode === "edge" && !win ? ["--edge"] : []), ...info.flags];
    const installer: UpdateStep = win
        ? { argv: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ".\\install.ps1", ...flags], display: [".\\install.ps1", ...flags].join(" ") }
        : { argv: ["./install.sh", ...flags] };
    return [pull, installer];
}

/** The command a human pastes: the same steps, from the source directory. */
export function updateCommand(info: InstallInfo): string {
    const win = info.platform === "windows";
    const steps = updateSteps(info);
    if (!steps) {
        return win
            ? "git pull in your aiball clone, then re-run install.ps1"
            : "git pull in your aiball clone, then re-run ./install.sh";
    }
    const q = win ? psq : shq;
    const cd = win ? `Set-Location ${psq(info.source!)}` : `cd ${shq(info.source!)}`;
    return [cd, ...steps.map((s) => s.display ?? s.argv.map(q).join(" "))].join(win ? "; " : " && ");
}

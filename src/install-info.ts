/**
 * #2586 — how this aiball was installed, as the installer recorded it, and the
 * command that updates it without changing the way it was installed.
 *
 * `install.sh` has three modes and `install.ps1` mirrors them:
 *   - `release` — the latest tag of a clone, copied into the install dir;
 *   - `edge`    — a checkout copied as it was (`--edge` / `-Edge`);
 *   - `dev`     — the install dir is a symlink to a checkout (`--symlink`).
 * Nothing recorded which one was used, so the installers now write
 * `<config dir>/install.json`. An install older than that reads `unknown`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { globalConfigPath } from "./autopoll/config.js";

export type InstallMode = "release" | "edge" | "dev" | "unknown";

export interface InstallInfo {
    mode: InstallMode;
    /** The clone or checkout the install came from. */
    source: string | null;
    /** The installer's own flags worth repeating (port, host, …), as typed. */
    flags: string[];
    platform: "posix" | "windows";
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
    return parseInstallInfo(text);
}

function shq(s: string): string {
    return /^[\w./:@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function psq(s: string): string {
    return /^[\w.:\\/@=+-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`;
}

/**
 * The command that updates this install the way it was installed — shown, not
 * run: installing from a desktop component is a later step.
 *
 * `install.sh` ships the latest tag REACHABLE from the clone's HEAD, so fetching
 * tags is not enough: the clone is pulled first. `install.ps1` copies the
 * checkout as it is (`edge`). A `dev` install runs the checkout itself: pull,
 * dependencies, frontend, restart.
 */
export function updateCommand(info: InstallInfo): string {
    const flags = info.flags.join(" ");
    const win = info.platform === "windows";
    if (!info.source) {
        return win
            ? "git pull in your aiball clone, then re-run install.ps1"
            : "git pull in your aiball clone, then re-run ./install.sh";
    }
    const join = (parts: string[]) => parts.join(win ? "; " : " && ");
    const cd = win ? `Set-Location ${psq(info.source)}` : `cd ${shq(info.source)}`;
    const pull = "git pull --ff-only --tags";
    const installer = win ? ".\\install.ps1" : "./install.sh";
    switch (info.mode) {
    case "release":
    case "edge":
    case "unknown":
        return join([cd, pull, `${installer}${info.mode === "edge" && !win ? " --edge" : ""}${flags ? ` ${flags}` : ""}`]);
    case "dev":
        return join([cd, pull, "npm install", "npm --prefix frontend run build", "aiball restart"]);
    }
}

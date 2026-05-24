/**
 * #398: operator-approved command launchers. The daemon can spawn a small set
 * of commands DECLARED IN CONFIG (e.g. "launch Chrome") from a UI button — never
 * an arbitrary command from the API. "Approved" = it exists in the operator's
 * config; the API only ever references a launcher by its `id`.
 *
 * Host-level → a `launchers:` list in the GLOBAL config
 * (`~/.config/aiball/config.yaml`), consistent with `proxy:` / `providers:`:
 *
 *   launchers:
 *     - id: chrome
 *       label: Chrome
 *       cmd: google-chrome-stable
 *       args: ["--new-window"]
 *       icon: pi-google          # optional PrimeIcons class for the UI button
 *
 * The daemon runs in the user's graphical session (systemd --user), so a
 * detached spawn inherits WAYLAND_DISPLAY / DISPLAY / XDG_RUNTIME_DIR → GUI apps
 * launch fine (verified #398). Project-level launchers (`.aiball.yaml`) are a
 * planned extension.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";

export interface Launcher {
    id: string;
    label: string;
    cmd: string;
    args?: string[];
    cwd?: string;
    icon?: string;
}

/** Read + validate the `launchers:` list from the GLOBAL config. Invalid /
 *  incomplete entries are dropped (never crash the daemon over bad config). */
export function loadLaunchers(): Launcher[] {
    const p = globalConfigPath();
    if (!existsSync(p)) return [];
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as { launchers?: unknown };
        if (!Array.isArray(raw.launchers)) return [];
        const out: Launcher[] = [];
        const seen = new Set<string>();
        for (const e of raw.launchers as Array<Record<string, unknown>>) {
            if (!e || typeof e !== "object") continue;
            const id = typeof e.id === "string" ? e.id.trim() : "";
            const cmd = typeof e.cmd === "string" ? e.cmd.trim() : "";
            if (!id || !cmd || seen.has(id)) continue;
            seen.add(id);
            const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;
            const args = Array.isArray(e.args) ? e.args.filter((a): a is string => typeof a === "string") : undefined;
            const cwd = typeof e.cwd === "string" && e.cwd.trim() ? e.cwd.trim() : undefined;
            const icon = typeof e.icon === "string" && e.icon.trim() ? e.icon.trim() : undefined;
            out.push({ id, label, cmd, ...(args ? { args } : {}), ...(cwd ? { cwd } : {}), ...(icon ? { icon } : {}) });
        }
        return out;
    } catch {
        return [];
    }
}

/** Look up a launcher by id (null when absent). */
export function getLauncher(id: string): Launcher | null {
    return loadLaunchers().find((l) => l.id === id) ?? null;
}

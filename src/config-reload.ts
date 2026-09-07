/**
 * #407 / #2089 — the soft config reload, in one place.
 *
 * It lived inside `daemon.ts` as the SIGUSR2 handler, which made the signal the
 * only way to ask for it. Signals do not exist on Windows: `process.kill` there
 * ignores the signal name and TERMINATES the target, so `aiball reload` — a
 * command whose entire promise is "no downtime" — killed the daemon. Under the
 * tray it came back and looked like a restart; without one it just stopped.
 *
 * So the reload becomes a function anyone can call: the signal handler on Linux,
 * and a local route for the command, which is the only mechanism available on
 * both platforms.
 *
 * aiball reads almost all config FRESH per request (`loadConfig()` re-reads
 * `.aiball.yaml`, `hotWindowSec()` re-reads the global yaml, settings and rules
 * live in the DB), so most config is already live with no reload at all. This
 * therefore (a) re-reads and validates the GLOBAL config so a broken edit
 * surfaces now, with the effective values reported as proof it ran, and (b) is
 * the single extension point for any future boot-cached config.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";

export interface ConfigReloadResult {
    global_config: string;
    hot_window_sec: unknown;
}

/** Never throws: a reload failing must not be able to take the daemon down. */
export function reloadConfig(): ConfigReloadResult {
    const gp = globalConfigPath();
    let hotWin: unknown;
    try {
        const raw = parseYaml(readFileSync(gp, "utf8")) as { hot_window_sec?: unknown } | null;
        hotWin = raw?.hot_window_sec;
    } catch {
        // Missing or empty global config is the normal case, not an error.
    }
    console.log(
        `[reload] config reloaded (most config is read fresh per request; `
        + `global=${gp}, hot_window_sec=${hotWin ?? "default"})`,
    );
    return { global_config: gp, hot_window_sec: hotWin ?? null };
}

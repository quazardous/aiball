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
import { globalConfigPath, globalConfigValue } from "./config/file-reader.js";
import { publish } from "./bus/subscriptions.js";

export interface ConfigReloadResult {
    global_config: string;
    hot_window_sec: unknown;
}

/** Never throws: a reload failing must not be able to take the daemon down. */
export function reloadConfig(): ConfigReloadResult {
    const gp = globalConfigPath();
    // #3250 — through the schema, as every read of it.
    const hotWin: unknown = globalConfigValue("hot_window_sec");
    console.log(
        `[reload] config reloaded (most config is read fresh per request; `
        + `global=${gp}, hot_window_sec=${hotWin ?? "default"})`,
    );
    // #3137 — a settings screen left open reads the config again.
    try { publish("config.changed", { op: "reload" }); } catch { /* never takes the reload down */ }
    return { global_config: gp, hot_window_sec: hotWin ?? null };
}

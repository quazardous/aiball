/**
 * #689 — single yaml-config snapshot for the runtime processes (timer +
 * hooks). Replaces the per-knob `process.env[CL_ENV.X]` reads with a
 * direct loadConfig call so the yaml schema (`autopoll/config.ts`) is
 * the ONE place to add / type / default a knob.
 *
 * Cached per-process : first call hits the yaml ; subsequent calls
 * return the same snapshot. That gives the same atomicity per-process
 * that the env-file snapshot used to provide globally, at the cost of
 * one yaml parse per spawned hook (~5-20 ms — david `dy54ks` epsilon).
 *
 * The cwd source : `AIBALL_PROJECT_CWD` is exported into the env file by
 * `claude-loop start` (cli.ts) and sourced by every hook + timer ; the
 * bare `process.cwd()` fallback exists for stand-alone invocations
 * (tests, debug-proxy-tty, etc.) that haven't been spawned from a loop.
 */
import { loadConfig, type AiballConfig } from "../autopoll/config.js";
import { CL_ENV } from "./env-vars.js";

let cached: AiballConfig | null = null;

export function loopConfig(): AiballConfig {
    if (cached === null) {
        const cwd = process.env.AIBALL_PROJECT_CWD ?? process.cwd();
        const cfg = loadConfig(cwd);
        applyEnvOverrides(cfg);
        cached = cfg;
    }
    return cached;
}

/**
 * #689 — shell-env override layer on top of the loaded yaml. Single
 * place to declare the mapping between each yaml-backed knob and its
 * `CL_*` env var. cli.ts:collectShellOverrideLines puts user-supplied
 * values in the volatile `env.local` at start (#991) ; hooks + timer
 * source `env` then `env.local` → their
 * `process.env[CL_ENV.X]` is the override ; this function lifts it
 * into the cached config. Skipped values fall back to yaml/defaults.
 */
function applyEnvOverrides(cfg: AiballConfig): void {
    const cl = cfg.claude_loop;
    const env = process.env;
    const num = (k: string): number | undefined => {
        const v = env[k];
        if (v === undefined || v.trim() === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    };
    const str = (k: string): string | undefined => {
        const v = env[k];
        return v !== undefined && v.trim() !== "" ? v : undefined;
    };
    const bool = (k: string): boolean | undefined => {
        const v = env[k];
        return v === "1" ? true : v === "0" ? false : undefined;
    };

    let ov: number | string | boolean | undefined;
    if ((ov = num(CL_ENV.INTERVAL)) !== undefined) cl.interval_seconds = ov;
    if ((ov = num(CL_ENV.BOOT_GRACE_SEC)) !== undefined) cl.boot_grace_seconds = ov;
    if ((ov = num(CL_ENV.BOOT_MIN_SEC)) !== undefined) cl.boot_min_seconds = ov;
    if ((ov = num(CL_ENV.WAKE_IN_FLIGHT_TTL_MS)) !== undefined) cl.wake_in_flight_ttl_ms = ov;
    if ((ov = num(CL_ENV.AFK_WINDOW_MS)) !== undefined) cl.afk_window_ms = ov;
    if ((ov = bool(CL_ENV.WAIT)) !== undefined) cl.wait = ov;
    if ((ov = bool(CL_ENV.AUTO_RESUME)) !== undefined) cl.auto_resume = ov;
    if ((ov = bool(CL_ENV.ESC_TAKEOVER)) !== undefined) cl.esc_takeover = ov;
    if ((ov = str(CL_ENV.DRAINED_STRATEGY)) !== undefined) cl.drained_strategy = ov;
    if ((ov = str(CL_ENV.LOG_LEVEL)) !== undefined) cl.log_level = ov;
    // #722 — input-hot + 2-rate pane probe env overrides.
    if ((ov = num(CL_ENV.INPUT_HOT_TTL_MS)) !== undefined) cl.input_hot_ttl_ms = ov;
    if ((ov = num(CL_ENV.PANE_PROBE_FAST_MS)) !== undefined) cl.pane_probe_fast_ms = ov;
    if ((ov = num(CL_ENV.PANE_PROBE_SLOW_MS)) !== undefined) cl.pane_probe_slow_ms = ov;
}

/** For tests — clear the cache so a fresh loadConfig runs on next call. */
export function _resetLoopConfigCacheForTests(): void {
    cached = null;
}

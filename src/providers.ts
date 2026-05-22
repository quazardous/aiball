/**
 * #354 v1: remote-access providers (tailscale, and future cloudflared/…).
 *
 * Config is HOST-level — remote access exposes the whole machine's daemon —
 * so the `providers:` block lives in the GLOBAL config
 * (`~/.config/aiball/config.yaml`), not per-project `.aiball.yaml`. v1
 * implements **tailscale only** and **autostart only** (bring up at daemon
 * start; no supervision/re-up loop yet — that's a follow-up).
 *
 * Autostart is wired as the systemd unit's `ExecStartPost` running
 * `aiball providers up`, so the provider comes up whenever the daemon
 * (re)starts. The actual bring-up reuses `bin/aiball-tailscale`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";

export interface TailscaleProvider {
    enabled: boolean;
    autostart: boolean;
    /** `https` (default) or `http` — maps to `aiball-tailscale up [--http]`. */
    mode: "https" | "http";
    /** Optional listen port override (→ `--port`). */
    port?: number;
}

export interface ProvidersConfig {
    tailscale?: TailscaleProvider;
}

/**
 * Read the `providers:` block from the GLOBAL config. Missing file/block →
 * empty config (no provider managed — safe default). A present provider
 * block defaults `enabled` and `autostart` to true (declaring it = wanting
 * it); set them false to keep the entry but inactive.
 */
export function loadProviders(): ProvidersConfig {
    const p = globalConfigPath();
    if (!existsSync(p)) return {};
    try {
        const raw = (parseYaml(readFileSync(p, "utf8")) ?? {}) as {
            providers?: Record<string, unknown>;
        };
        const prov = raw.providers;
        if (!prov || typeof prov !== "object") return {};
        const out: ProvidersConfig = {};
        const ts = (prov as Record<string, unknown>).tailscale as Record<string, unknown> | undefined;
        if (ts && typeof ts === "object") {
            out.tailscale = {
                enabled: ts.enabled !== false,
                autostart: ts.autostart !== false,
                mode: ts.mode === "http" ? "http" : "https",
                port: typeof ts.port === "number" ? ts.port : undefined,
            };
        }
        return out;
    } catch {
        return {};
    }
}

/** Resolve the shipped `bin/aiball-tailscale` (repo root is two up from src/). */
function tailscaleBin(): string {
    const here = dirname(fileURLToPath(import.meta.url)); // src/
    return join(here, "..", "bin", "aiball-tailscale");
}

export interface ProviderResult {
    provider: string;
    ok: boolean;
    detail: string;
}

/**
 * Bring up providers. `onlyAutostart` (used by the daemon's ExecStartPost)
 * restricts to entries with `autostart: true`; the manual `up` command
 * passes false to force every enabled provider. No-op when nothing's
 * configured.
 */
export function bringUpProviders(opts: { onlyAutostart?: boolean } = {}): ProviderResult[] {
    const cfg = loadProviders();
    const results: ProviderResult[] = [];
    const ts = cfg.tailscale;
    if (ts && ts.enabled && (!opts.onlyAutostart || ts.autostart)) {
        const args = ["up"];
        if (ts.mode === "http") args.push("--http");
        if (ts.port) args.push("--port", String(ts.port));
        const r = spawnSync(tailscaleBin(), args, { encoding: "utf8" });
        results.push({
            provider: "tailscale",
            ok: r.status === 0,
            detail: ((r.stdout ?? "") + (r.stderr ?? "")).trim() || (r.error ? String(r.error) : ""),
        });
    }
    return results;
}

/** Take down all configured providers (`aiball-tailscale down`). */
export function bringDownProviders(): ProviderResult[] {
    const cfg = loadProviders();
    const results: ProviderResult[] = [];
    if (cfg.tailscale) {
        const r = spawnSync(tailscaleBin(), ["down"], { encoding: "utf8" });
        results.push({
            provider: "tailscale",
            ok: r.status === 0,
            detail: ((r.stdout ?? "") + (r.stderr ?? "")).trim() || (r.error ? String(r.error) : ""),
        });
    }
    return results;
}

/** Configured providers + live tailscale serve status (best-effort). */
export function providersStatus(): { config: ProvidersConfig; tailscale: string | null } {
    const config = loadProviders();
    let tailscale: string | null = null;
    if (config.tailscale) {
        const r = spawnSync(tailscaleBin(), ["status"], { encoding: "utf8" });
        tailscale = ((r.stdout ?? "") + (r.stderr ?? "")).trim() || null;
    }
    return { config, tailscale };
}

/**
 * #354: remote-access providers (tailscale, and future cloudflared/…).
 *
 * Config is HOST-level — remote access exposes the whole machine's daemon —
 * so the `providers:` block lives in the GLOBAL config
 * (`~/.config/aiball/config.yaml`), not per-project `.aiball.yaml`. v1
 * implements **tailscale only** and **autostart only** (bring up at daemon
 * start; no supervision/re-up loop yet — that's a follow-up).
 *
 * Autostart is wired as the systemd unit's `ExecStartPost` running
 * `aiball providers up`, so the provider comes up whenever the daemon
 * (re)starts.
 *
 * #380: the bring-up/down/status logic was inlined here (calling `tailscale`
 * directly) — the former `bin/aiball-tailscale` helper script is gone. This
 * module IS the unified provider manager; per-provider logic lives in the
 * `tailscale*` helpers below. A future provider (cloudflared, ngrok…) adds
 * its own helpers + a `providers.<name>` config sub-key.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { globalConfigPath } from "./autopoll/config.js";

export interface TailscaleProvider {
    enabled: boolean;
    autostart: boolean;
    /** `https` (default) serves on 443; `http` serves on 80 (no certs). */
    mode: "https" | "http";
    /** Optional listen-port override (default 443 https / 80 http). */
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

export interface ProviderResult {
    provider: string;
    ok: boolean;
    detail: string;
}

// ---- tailscale provider (#380: inlined from the old bin/aiball-tailscale) ----

/**
 * Resolve the daemon's port to proxy: `AIBALL_PORT` env → the systemd bind
 * drop-in (`~/.config/systemd/user/aiball.service.d/bind.conf`) → 7777.
 */
function resolveDaemonPort(): number {
    const env = process.env.AIBALL_PORT;
    if (env && /^\d+$/.test(env)) return Number(env);
    const dropin = join(homedir(), ".config", "systemd", "user", "aiball.service.d", "bind.conf");
    if (existsSync(dropin)) {
        try {
            const matches = readFileSync(dropin, "utf8").match(/AIBALL_PORT=(\d+)/g);
            if (matches && matches.length) {
                const last = matches[matches.length - 1].split("=")[1];
                if (last) return Number(last);
            }
        } catch { /* fall through to default */ }
    }
    return 7777;
}

/** `tailscale` present AND logged in? Returns a reason when not. */
function tailscaleReady(): { ok: boolean; reason: string } {
    const ver = spawnSync("tailscale", ["version"], { encoding: "utf8" });
    if (ver.error || ver.status !== 0) {
        return { ok: false, reason: "tailscale not found — install from https://tailscale.com/download" };
    }
    const st = spawnSync("tailscale", ["status"], { encoding: "utf8" });
    if (st.status !== 0) {
        return { ok: false, reason: "tailscale not logged in — run: sudo tailscale up" };
    }
    return { ok: true, reason: "" };
}

/** `tailscale serve --bg --https=<listen> 127.0.0.1:<daemon-port>` (or --http). */
function tailscaleUp(mode: "https" | "http", portOverride?: number): ProviderResult {
    const ready = tailscaleReady();
    if (!ready.ok) return { provider: "tailscale", ok: false, detail: ready.reason };
    const target = `127.0.0.1:${resolveDaemonPort()}`;
    const listen = portOverride ?? (mode === "http" ? 80 : 443);
    const flag = mode === "http" ? `--http=${listen}` : `--https=${listen}`;
    const r = spawnSync("tailscale", ["serve", "--bg", flag, target], { encoding: "utf8" });
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    if (r.status !== 0) {
        const hint = mode === "https"
            ? " — HTTPS serve failed; MagicDNS + HTTPS certs may be off (set providers.tailscale.mode: http to fall back)"
            : "";
        return { provider: "tailscale", ok: false, detail: (out || String(r.error ?? "serve failed")) + hint };
    }
    return { provider: "tailscale", ok: true, detail: out || `serve --bg ${flag} ${target}` };
}

/** `tailscale serve reset`. */
function tailscaleDown(): ProviderResult {
    const ready = tailscaleReady();
    if (!ready.ok) return { provider: "tailscale", ok: false, detail: ready.reason };
    const r = spawnSync("tailscale", ["serve", "reset"], { encoding: "utf8" });
    return {
        provider: "tailscale",
        ok: r.status === 0,
        detail: ((r.stdout ?? "") + (r.stderr ?? "")).trim() || (r.error ? String(r.error) : "serve reset"),
    };
}

/** Raw `tailscale serve status` output (null when empty / unavailable). */
function tailscaleServeStatus(): string | null {
    const r = spawnSync("tailscale", ["serve", "status"], { encoding: "utf8" });
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    return out || null;
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
        results.push(tailscaleUp(ts.mode, ts.port));
    }
    return results;
}

/** Take down all configured providers. */
export function bringDownProviders(): ProviderResult[] {
    const cfg = loadProviders();
    const results: ProviderResult[] = [];
    if (cfg.tailscale) results.push(tailscaleDown());
    return results;
}

/** Configured providers + live tailscale serve status (best-effort). */
export function providersStatus(): { config: ProvidersConfig; tailscale: string | null } {
    const config = loadProviders();
    return { config, tailscale: config.tailscale ? tailscaleServeStatus() : null };
}

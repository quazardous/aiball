/**
 * The machine half of `aiball check` (#2282).
 *
 * The project half answers "is THIS directory wired?". It says nothing about
 * the box underneath: a daemon running an older version than the CLI, a token
 * the daemon no longer accepts, a PTY proxy that silently fell back to Python,
 * a tailnet URL that stopped serving. Those were each diagnosed by hand, one
 * command at a time, by someone who already knew where to look.
 *
 * Split in two so the verdicts can be tested without a machine:
 *   - `probeMachine` gathers facts (spawns, socket, HTTP) and judges nothing;
 *   - `assembleMachineReport` turns facts into lines, each with a status and,
 *     when something is wrong, the command that fixes it.
 *
 * Reports, never repairs — same contract as the rest of `check`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiballClient } from "./client.js";
import { BUILD_CMD, resolveProxyLaunch, type ProxyLaunch } from "./claude-loop/proxy-launch.js";
import type { PrereqStatus } from "./sysdeps.js";

export type MachineStatus = "ok" | "warn" | "error";

export interface MachineLine {
    id: "daemon" | "socket" | "caller" | "web_login" | "tmux" | "claude" | "pty_proxy" | "tailscale";
    status: MachineStatus;
    detail: string;
    /** Ready-to-paste command (or instruction) that clears a warn/error. */
    fix?: string;
}

export interface ToolProbe {
    cmd: string;
    /** First line of `<cmd> --version`; null when the command does not run. */
    version: string | null;
    /** Install command for this machine's package manager, when known. */
    install: string | null;
}

export interface TailscaleProbe {
    mode: "https" | "http";
    listen: number;
    path?: string;
    enabled: boolean;
    installed: boolean;
    /** `BackendState === "Running"`. */
    running: boolean;
    /** MagicDNS name without the trailing dot, when known. */
    dnsName: string | null;
    /** A serve handler for our listen port + path proxies to the daemon. */
    serving: boolean;
}

export interface MachineProbes {
    cliVersion: string;
    /** Null when this machine talks TCP by design (Windows default, `AIBALL_SOCK=""`). */
    socket: { path: string; exists: boolean } | null;
    /** How the CLI reaches the daemon: its socket, a bearer token, or neither. */
    transport: "socket" | "token" | "none";
    daemon: { up: boolean; version: string | null; error: string | null };
    /** `/api/auth/status`; null when the daemon did not answer it. */
    auth: {
        ready: boolean;
        install_available: boolean;
        install_expires_at: string | null;
        me: { consumer_id: string; kind: string } | null;
    } | null;
    /** The agent this CLI speaks as — only used to name the token to mint. */
    agent: string | null;
    tmux: ToolProbe;
    claude: ToolProbe;
    proxy: ProxyLaunch;
    cargo: { present: boolean; install: string | null };
    /** Null when no tailscale provider is configured — the line is skipped. */
    tailscale: TailscaleProbe | null;
}

/** Pure: facts in, verdicts out. */
export function assembleMachineReport(p: MachineProbes): MachineLine[] {
    const lines: MachineLine[] = [];

    // --- daemon ---------------------------------------------------------
    if (!p.daemon.up) {
        lines.push({
            id: "daemon",
            status: "error",
            detail: `not reachable${p.daemon.error ? ` — ${p.daemon.error}` : ""}`,
            fix: "systemctl --user start aiball",
        });
    } else if (p.daemon.version && p.daemon.version !== p.cliVersion) {
        // The CLI is read from disk on every run, the daemon at its last boot:
        // a mismatch means code landed and the daemon never picked it up.
        lines.push({
            id: "daemon",
            status: "warn",
            detail: `runs v${p.daemon.version}, the CLI is v${p.cliVersion}`,
            fix: "aiball restart",
        });
    } else {
        lines.push({ id: "daemon", status: "ok", detail: `up, v${p.daemon.version ?? "?"}` });
    }

    // --- socket ---------------------------------------------------------
    if (!p.socket) {
        // Nothing to report: no socket is expected here.
    } else if (p.socket.exists) {
        lines.push({ id: "socket", status: "ok", detail: p.socket.path });
    } else {
        // Without the socket the CLI and every MCP server fall back to TCP and
        // need a token — a daemon that is up but lost its socket reads as an
        // auth failure everywhere else.
        lines.push({
            id: "socket",
            status: p.daemon.up ? "warn" : "error",
            detail: `missing: ${p.socket.path}`,
            fix: p.daemon.up ? "aiball restart" : "systemctl --user start aiball",
        });
    }

    // --- caller: is THIS process authenticated? --------------------------
    const issue = `aiball auth issue --consumer ${p.agent ?? "<agent-id>"}`;
    if (p.transport === "socket") {
        lines.push({ id: "caller", status: "ok", detail: "local socket — trusted, no token needed" });
    } else if (p.transport === "none") {
        lines.push({
            id: "caller",
            status: "error",
            detail: "no socket and no AIBALL_TOKEN — the daemon cannot tell who is calling",
            fix: `${issue}, then export AIBALL_TOKEN`,
        });
    } else if (!p.auth) {
        lines.push({ id: "caller", status: "warn", detail: "AIBALL_TOKEN set, but the daemon did not answer to verify it" });
    } else if (p.auth.me) {
        lines.push({ id: "caller", status: "ok", detail: `token accepted — ${p.auth.me.consumer_id} (${p.auth.me.kind})` });
    } else {
        lines.push({
            id: "caller",
            status: "error",
            detail: "AIBALL_TOKEN is not accepted by the daemon (revoked, expired, or not an agent token)",
            fix: `${issue}, then export AIBALL_TOKEN`,
        });
    }

    // --- web login ------------------------------------------------------
    if (p.auth) {
        const until = p.auth.install_expires_at ? ` until ${p.auth.install_expires_at}` : "";
        if (!p.auth.ready && !p.auth.install_available) {
            lines.push({
                id: "web_login",
                status: "error",
                detail: "no human login configured and no valid install token — the board cannot be opened",
                fix: "aiball auth reinit",
            });
        } else if (!p.auth.ready) {
            lines.push({
                id: "web_login",
                status: "warn",
                detail: `setup pending — install token valid${until}`,
                fix: "open the /setup URL printed by `aiball auth init` (or mint a fresh one: aiball auth reinit)",
            });
        } else if (p.auth.install_available) {
            // A human exists AND /setup is open: legitimate while onboarding a
            // second human or resetting a password, worth seeing otherwise.
            lines.push({
                id: "web_login",
                status: "warn",
                detail: `human login configured, and an install token is still open${until}`,
                fix: "aiball auth list, then aiball auth revoke <token> — once nobody needs /setup",
            });
        } else {
            lines.push({ id: "web_login", status: "ok", detail: "human login configured" });
        }
    }

    // --- tools ----------------------------------------------------------
    for (const [id, tool, fallbackFix] of [
        ["tmux", p.tmux, null],
        ["claude", p.claude, "npm install -g @anthropic-ai/claude-code"],
    ] as const) {
        if (tool.version) {
            lines.push({ id, status: "ok", detail: tool.version });
        } else {
            const fix = tool.install ?? fallbackFix;
            lines.push({
                id,
                status: "error",
                detail: `${tool.cmd} does not run — no loop can start`,
                ...(fix ? { fix } : {}),
            });
        }
    }

    // --- PTY proxy ------------------------------------------------------
    if (p.proxy.kind === "rust") {
        lines.push({ id: "pty_proxy", status: "ok", detail: `Rust proxy built — ${p.proxy.bin}` });
    } else if (p.proxy.kind === "python") {
        const why = p.cargo.present ? "cl-pty-proxy is not built" : "cargo is not installed, so cl-pty-proxy cannot be built";
        lines.push({
            id: "pty_proxy",
            status: "warn",
            detail: `deprecated Python fallback — ${why}`,
            fix: p.cargo.present ? BUILD_CMD : `${p.cargo.install ?? "install cargo"}, then ${BUILD_CMD}`,
        });
    } else {
        lines.push({
            id: "pty_proxy",
            status: "error",
            detail: "no PTY proxy — `claude-loop start` refuses",
            fix: p.cargo.present ? BUILD_CMD : `${p.cargo.install ?? "install cargo"}, then ${BUILD_CMD}`,
        });
    }

    // --- tailscale (only when configured) -------------------------------
    const ts = p.tailscale;
    if (ts) {
        if (!ts.enabled) {
            lines.push({ id: "tailscale", status: "ok", detail: "configured but disabled (providers.tailscale.enabled: false)" });
        } else if (!ts.installed) {
            lines.push({
                id: "tailscale",
                status: "error",
                detail: "configured, but the tailscale command does not run",
                fix: "install tailscale — https://tailscale.com/download",
            });
        } else if (!ts.running) {
            lines.push({ id: "tailscale", status: "error", detail: "configured, but tailscale is not logged in / not running", fix: "sudo tailscale up" });
        } else if (!ts.serving) {
            lines.push({
                id: "tailscale",
                status: "error",
                detail: `running, but nothing serves the daemon on :${ts.listen}${ts.path ?? "/"}`,
                fix: "aiball providers up --all",
            });
        } else {
            lines.push({ id: "tailscale", status: "ok", detail: `serving ${tailscaleUrl(ts)}` });
        }
    }

    return lines;
}

/** The URL a tailnet peer opens. The default port for the scheme is left out. */
export function tailscaleUrl(ts: Pick<TailscaleProbe, "mode" | "listen" | "path" | "dnsName">): string {
    const defaultPort = ts.mode === "http" ? 80 : 443;
    const port = ts.listen === defaultPort ? "" : `:${ts.listen}`;
    return `${ts.mode}://${ts.dnsName ?? "<tailnet-name>"}${port}${ts.path ?? "/"}`;
}

/**
 * Does `tailscale serve status --json` carry a handler for our listen port and
 * path that proxies to the daemon's port? Pure, fed the parsed JSON.
 */
export function serveHandlesDaemon(
    status: unknown, listen: number, path: string | undefined, daemonPort: number,
): boolean {
    const web = (status as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web;
    if (!web) return false;
    const wanted = path ?? "/";
    return Object.entries(web).some(([host, site]) => {
        if (!host.endsWith(`:${listen}`)) return false;
        const proxy = site.Handlers?.[wanted]?.Proxy ?? "";
        return new RegExp(`:${daemonPort}/?$`).test(proxy);
    });
}

// =====================================================================
// Probes — the impure half
// =====================================================================

function firstVersionLine(cmd: string, args: string[]): string | null {
    try {
        const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, shell: process.platform === "win32" });
        if (r.status !== 0) return null;
        return (r.stdout || r.stderr || "").split(/\r?\n/)[0]?.trim() || null;
    } catch {
        return null;
    }
}

function spawnJson(cmd: string, args: string[]): unknown {
    try {
        const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
        if (r.status !== 0) return null;
        return JSON.parse(r.stdout);
    } catch {
        return null;
    }
}

function isSocket(path: string): boolean {
    // A Windows named pipe is not a filesystem entry `stat` can type.
    if (process.platform === "win32") return existsSync(path);
    try {
        return statSync(path).isSocket();
    } catch {
        return false;
    }
}

export interface ProbeMachineInput {
    client: AiballClient;
    cliVersion: string;
    /** `claude_loop.proxy_impl` from the resolved config. */
    proxyImpl: string;
    /** Already probed by the dependencies section — reused, not re-run. */
    dependencies: PrereqStatus[];
}

export async function probeMachine(input: ProbeMachineInput): Promise<MachineProbes> {
    const { client, cliVersion, dependencies } = input;
    const home = process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");
    // Mirrors the daemon's own choice (src/daemon.ts): an explicit AIBALL_SOCK
    // wins, "" opts out, and Windows is TCP-only by default.
    const envSock = process.env.AIBALL_SOCK;
    const sockPath = envSock === "" ? null
        : envSock ? envSock
        : process.platform === "win32" ? null
        : join(home, "sock");

    const daemon: MachineProbes["daemon"] = { up: false, version: null, error: null };
    try {
        const h = await client.health();
        daemon.up = true;
        daemon.version = h.version ?? null;
    } catch (e) {
        daemon.error = (e as Error).message;
    }

    let auth: MachineProbes["auth"] = null;
    if (daemon.up) {
        try {
            auth = await client.authStatus();
        } catch {
            auth = null;
        }
    }

    const dep = (cmd: string) => dependencies.find((d) => d.cmd === cmd);
    const muxCmd = process.platform === "win32" ? "psmux" : "tmux";
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const proxy = resolveProxyLaunch({
        platform: process.platform,
        proxyImpl: (process.env.CL_PROXY_IMPL ?? input.proxyImpl ?? "").trim().toLowerCase(),
        rustProxyBin: join(
            root, "windows", "cl-pty-proxy", "target", "release",
            process.platform === "win32" ? "cl-pty-proxy.exe" : "cl-pty-proxy",
        ),
        pyProxy: join(root, "src/claude-loop/pty-proxy.py"),
        exists: existsSync,
        hasPython3: dep("python3")?.present ?? false,
    });

    return {
        cliVersion,
        socket: sockPath ? { path: sockPath, exists: isSocket(sockPath) } : null,
        transport: client.socketPath ? "socket" : client.token ? "token" : "none",
        daemon,
        auth,
        agent: client.agentId ?? null,
        tmux: { cmd: muxCmd, version: firstVersionLine("tmux", ["-V"]), install: dep(muxCmd)?.install ?? null },
        claude: { cmd: "claude", version: firstVersionLine("claude", ["--version"]), install: null },
        proxy,
        cargo: { present: dep("cargo")?.present ?? false, install: dep("cargo")?.install ?? null },
        tailscale: await probeTailscale(),
    };
}

async function probeTailscale(): Promise<TailscaleProbe | null> {
    const { loadProviders, resolveDaemonPort } = await import("./providers.js");
    const cfg = loadProviders().tailscale;
    if (!cfg) return null;
    const listen = cfg.port ?? (cfg.mode === "http" ? 80 : 443);
    const base = { mode: cfg.mode, listen, path: cfg.path, enabled: cfg.enabled };
    if (!cfg.enabled) return { ...base, installed: false, running: false, dnsName: null, serving: false };
    const installed = firstVersionLine("tailscale", ["version"]) !== null;
    const status = installed
        ? (spawnJson("tailscale", ["status", "--json"]) as { BackendState?: string; Self?: { DNSName?: string } } | null)
        : null;
    const running = status?.BackendState === "Running";
    const dnsName = status?.Self?.DNSName?.replace(/\.$/, "") ?? null;
    const serving = running
        && serveHandlesDaemon(spawnJson("tailscale", ["serve", "status", "--json"]), listen, cfg.path, resolveDaemonPort());
    return { ...base, installed, running, dnsName, serving };
}

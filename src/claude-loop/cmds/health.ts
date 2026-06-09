/**
 * `claude-loop health [<name>]` — plomberie diagnostic (#860).
 *
 * 9 checks par loop : timer process + source SHA, loop.sock UDS, proxy
 * alive, tmux session, ipc freshness, boot status, aiball daemon, SSE.
 * Sortie text colorée (✅/⚠️/❌) ou `--json`. Exit code = 0 si tout
 * OK, 1 si un check ❌, 2 si au moins un ⚠️.
 *
 * Pure read-only ; aucun side-effect. Réutilise les helpers existants
 * de `state.ts` + le UDS `queryLoopState` du #774.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { request as httpRequest } from "node:http";
import {
    MUX_CMD,
    STATE_ROOT,
    installRoot,
    installRootSha,
    loopSockPath,
    proxyAlivePath,
    readPlate,
    stateDirFor,
    timerPidPath,
    tmuxName,
    type Plate,
} from "../state.js";
import { openEventChannel } from "../ipc-events.js";

export type HealthStatus = "ok" | "warn" | "fail";
export interface HealthCheck {
    name: string;
    status: HealthStatus;
    detail: string;
}
export interface HealthReport {
    loop_name: string;
    state_dir: string;
    exists: boolean;
    checks: HealthCheck[];
    summary: { ok: number; warn: number; fail: number };
}

const ICON: Record<HealthStatus, string> = {
    ok: "✅",
    warn: "⚠️ ",
    fail: "❌",
};

// ---------------------------------------------------------------------------
// Individual probes — each returns a HealthCheck.
// ---------------------------------------------------------------------------

interface PidProbe {
    pid: number | null;
    alive: boolean;
    cmdline: string | null;
}
function probePid(pidPath: string, cmdlineMatch: RegExp): PidProbe {
    if (!existsSync(pidPath)) return { pid: null, alive: false, cmdline: null };
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return { pid: null, alive: false, cmdline: null };
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    let cmdline: string | null = null;
    if (alive) {
        try {
            cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
            if (!cmdlineMatch.test(cmdline)) cmdline = null; // pid recycled
        } catch { cmdline = null; }
    }
    return { pid, alive, cmdline };
}

export function checkTimer(sd: string): HealthCheck {
    const p = probePid(timerPidPath(sd), /timer\.ts/);
    if (p.pid === null) return { name: "timer", status: "fail", detail: "timer.pid missing / unreadable" };
    if (!p.alive) return { name: "timer", status: "fail", detail: `pid ${p.pid} not running` };
    if (p.cmdline === null) {
        return {
            name: "timer",
            status: "fail",
            detail: `pid ${p.pid} alive but cmdline doesn't match timer.ts (= pid recycled)`,
        };
    }
    return { name: "timer", status: "ok", detail: `pid ${p.pid} running (tsx + timer.ts)` };
}

export function checkTimerSource(sd: string): HealthCheck {
    let plate: Plate;
    try { plate = readPlate(sd); }
    catch { return { name: "timer source", status: "warn", detail: "plate.json missing — can't compare SHA" }; }
    const boot = plate.started_at_sha;
    const now = installRootSha();
    if (boot === null || boot === undefined) {
        return { name: "timer source", status: "warn", detail: "plate.started_at_sha unset" };
    }
    if (now === null) {
        return { name: "timer source", status: "warn", detail: `boot SHA ${boot.slice(0, 7)} — current SHA unknown (no .git?)` };
    }
    if (boot === now) return { name: "timer source", status: "ok", detail: `SHA ${now.slice(0, 7)} (current)` };
    return {
        name: "timer source",
        status: "warn",
        detail: `stale (boot=${boot.slice(0, 7)}, now=${now.slice(0, 7)}) — reload to pick up new code`,
    };
}

interface LiveLoopState {
    paneBusy?: boolean;
    paneReady?: boolean;
    paneCompacting?: boolean;
    paneResuming?: boolean;
    paneInterrupted?: boolean;
    afkMode?: "off" | "wait_10m" | "wait_inf" | null;
    afkExpiryMs?: number | null;
    humanTypingAtMs?: number | null;
    idleSinceMs?: number | null;
    bootComplete?: boolean | null;
    busyDeferUntilMs?: number | null;
    lastViewPushAtMs?: number | null;
}
async function queryUdsLoopState(sd: string, timeoutMs = 500): Promise<{ live: LiveLoopState | null; latencyMs: number; sockMissing: boolean }> {
    const sock = loopSockPath(sd);
    if (!existsSync(sock)) return { live: null, latencyMs: -1, sockMissing: true };
    const t0 = Date.now();
    const ch = openEventChannel(sock, { reconnectMs: 100 });
    try {
        const connected = await new Promise<boolean>((resolve) => {
            const start = Date.now();
            const tick = (): void => {
                if (ch.isConnected()) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                setTimeout(tick, 10);
            };
            tick();
        });
        if (!connected) return { live: null, latencyMs: Date.now() - t0, sockMissing: false };
        const reply = await ch.request({ kind: "queryLoopState" }, timeoutMs);
        return { live: (reply.data as LiveLoopState | undefined) ?? null, latencyMs: Date.now() - t0, sockMissing: false };
    } catch {
        return { live: null, latencyMs: Date.now() - t0, sockMissing: false };
    } finally {
        ch.close();
    }
}

export function checkLoopSock(latencyMs: number, sockMissing: boolean, live: LiveLoopState | null): HealthCheck {
    if (sockMissing) return { name: "loop.sock", status: "fail", detail: "socket file missing" };
    if (live === null) return { name: "loop.sock", status: "fail", detail: `no reply within ${latencyMs}ms (timer down or hung)` };
    return { name: "loop.sock", status: "ok", detail: `responding (${latencyMs}ms round-trip)` };
}

export function checkProxy(sd: string): HealthCheck {
    const p = probePid(proxyAlivePath(sd), /pty-proxy\.py/);
    if (p.pid === null) return { name: "proxy", status: "warn", detail: "proxy-alive missing (running without PTY proxy?)" };
    if (!p.alive) return { name: "proxy", status: "fail", detail: `pid ${p.pid} not running` };
    if (p.cmdline === null) {
        return { name: "proxy", status: "fail", detail: `pid ${p.pid} alive but cmdline doesn't match pty-proxy.py` };
    }
    return { name: "proxy", status: "ok", detail: `pid ${p.pid} running (pty-proxy.py)` };
}

export function checkTmuxSession(name: string): HealthCheck {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    if (r.error) {
        return { name: "tmux session", status: "warn", detail: `${MUX_CMD} spawn error: ${r.error.message}` };
    }
    if (r.status === 0) return { name: "tmux session", status: "ok", detail: `${tmuxName(name)} exists` };
    return { name: "tmux session", status: "fail", detail: `${tmuxName(name)} doesn't exist` };
}

const IPC_FRESH_TTL_MS = 10_000;
export function checkIpcFreshness(live: LiveLoopState | null, nowMs: number = Date.now()): HealthCheck {
    if (live === null) {
        return { name: "ipc freshness", status: "fail", detail: "no UDS reply (skipped)" };
    }
    const ts = live.lastViewPushAtMs ?? null;
    if (ts === null) {
        return { name: "ipc freshness", status: "warn", detail: "no view-push yet (cold boot)" };
    }
    const ageMs = nowMs - ts;
    if (ageMs > IPC_FRESH_TTL_MS) {
        return { name: "ipc freshness", status: "fail", detail: `last push ${(ageMs / 1000).toFixed(1)}s ago (> ${IPC_FRESH_TTL_MS / 1000}s — bus frozen?)` };
    }
    return { name: "ipc freshness", status: "ok", detail: `last push ${(ageMs / 1000).toFixed(1)}s ago` };
}

export function checkBootStatus(sd: string, live: LiveLoopState | null, nowMs: number = Date.now()): HealthCheck {
    if (live === null) return { name: "boot status", status: "fail", detail: "no UDS reply (skipped)" };
    if (live.bootComplete === true) {
        return { name: "boot status", status: "ok", detail: "sealed" };
    }
    // Boot not sealed. Could be legit (early boot) or stuck.
    let elapsedMs = 0;
    try {
        const startTs = readFileSync(join(sd, "loop-start-ts"), "utf8").trim();
        const start = Number(startTs);
        if (Number.isFinite(start) && start > 0) elapsedMs = nowMs - start;
    } catch { /* unknown — assume just-started */ }
    if (elapsedMs < 60_000) {
        return { name: "boot status", status: "warn", detail: `boot in progress (elapsed ${(elapsedMs / 1000).toFixed(0)}s)` };
    }
    return {
        name: "boot status",
        status: "fail",
        detail: `stuck in boot ${(elapsedMs / 1000).toFixed(0)}s — pickers/compacting holding ?`,
    };
}

export async function checkAiballDaemon(timeoutMs = 500): Promise<HealthCheck> {
    const aiballHome = process.env.AIBALL_HOME ?? join(homedir(), ".local", "share", "aiball");
    const sock = process.env.AIBALL_SOCK || join(aiballHome, "sock");
    return new Promise<HealthCheck>((resolve) => {
        if (!existsSync(sock)) {
            resolve({ name: "aiball daemon", status: "fail", detail: `sock missing : ${sock}` });
            return;
        }
        const req = httpRequest(
            { socketPath: sock, path: "/api/health", method: "GET", timeout: timeoutMs },
            (res) => {
                let body = "";
                res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
                res.on("end", () => {
                    if (res.statusCode !== 200) {
                        resolve({ name: "aiball daemon", status: "fail", detail: `HTTP ${res.statusCode}` });
                        return;
                    }
                    try {
                        const j = JSON.parse(body) as { version?: string; ok?: boolean };
                        if (j.ok === false) { resolve({ name: "aiball daemon", status: "fail", detail: `unhealthy: ${body.slice(0, 80)}` }); return; }
                        resolve({ name: "aiball daemon", status: "ok", detail: `up (v${j.version ?? "?"})` });
                    } catch {
                        resolve({ name: "aiball daemon", status: "warn", detail: `parse error: ${body.slice(0, 80)}` });
                    }
                });
            },
        );
        req.on("error", (e) => resolve({ name: "aiball daemon", status: "fail", detail: e.message }));
        req.on("timeout", () => { req.destroy(); resolve({ name: "aiball daemon", status: "fail", detail: `timeout ${timeoutMs}ms` }); });
        req.end();
    });
}

/** SSE channel check — needs a daemon-side `/api/loops/<name>/presence`
 *  endpoint that doesn't exist yet. Deferred to a follow-up spinoff ;
 *  surfaced here as a `warn` placeholder so the check inventory is
 *  visible. */
export function checkSse(): HealthCheck {
    return { name: "SSE channel", status: "warn", detail: "not implemented (daemon presence endpoint pending)" };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export async function runHealthChecks(name: string): Promise<HealthReport> {
    const sd = stateDirFor(name);
    const checks: HealthCheck[] = [];
    if (!existsSync(sd)) {
        return {
            loop_name: name,
            state_dir: sd,
            exists: false,
            checks: [{ name: "state dir", status: "fail", detail: `${sd} doesn't exist` }],
            summary: { ok: 0, warn: 0, fail: 1 },
        };
    }
    checks.push(checkTimer(sd));
    checks.push(checkTimerSource(sd));
    const { live, latencyMs, sockMissing } = await queryUdsLoopState(sd);
    checks.push(checkLoopSock(latencyMs, sockMissing, live));
    checks.push(checkProxy(sd));
    checks.push(checkTmuxSession(name));
    checks.push(checkIpcFreshness(live));
    checks.push(checkBootStatus(sd, live));
    checks.push(await checkAiballDaemon());
    checks.push(checkSse());
    const summary = { ok: 0, warn: 0, fail: 0 };
    for (const c of checks) summary[c.status] += 1;
    return { loop_name: name, state_dir: sd, exists: true, checks, summary };
}

// ---------------------------------------------------------------------------
// CLI entry.
// ---------------------------------------------------------------------------

function formatReport(report: HealthReport): string {
    const lines: string[] = [];
    const nameWidth = Math.max(...report.checks.map((c) => c.name.length));
    for (const c of report.checks) {
        lines.push(`${ICON[c.status]} ${c.name.padEnd(nameWidth)}  ${c.detail}`);
    }
    lines.push("");
    const { ok, warn, fail } = report.summary;
    if (fail > 0) lines.push(`${fail} check${fail > 1 ? "s" : ""} failed (exit 1)${warn ? `, ${warn} warning${warn > 1 ? "s" : ""}` : ""}.`);
    else if (warn > 0) lines.push(`${ok} check${ok > 1 ? "s" : ""} passed, ${warn} warning${warn > 1 ? "s" : ""} (exit 2).`);
    else lines.push(`All ${ok} checks passed.`);
    return lines.join("\n");
}

function exitCodeFor(report: HealthReport): 0 | 1 | 2 {
    if (report.summary.fail > 0) return 1;
    if (report.summary.warn > 0) return 2;
    return 0;
}

export async function cmdHealth(nameArg: string | undefined, opts: { json?: boolean }): Promise<void> {
    const names: string[] = [];
    if (nameArg) names.push(nameArg);
    else {
        // No arg → check every state dir.
        try {
            const { readdirSync } = await import("node:fs");
            const dirs = readdirSync(STATE_ROOT);
            for (const d of dirs) {
                if (existsSync(join(STATE_ROOT, d, "plate.json"))) names.push(d);
            }
        } catch { /* no loops */ }
    }
    if (names.length === 0) {
        if (opts.json) process.stdout.write(JSON.stringify([], null, 2) + "\n");
        else process.stdout.write("no loops found\n");
        process.exit(0);
    }
    const reports: HealthReport[] = [];
    for (const n of names) reports.push(await runHealthChecks(n));
    if (opts.json) {
        process.stdout.write(JSON.stringify(reports, null, 2) + "\n");
    } else {
        for (const r of reports) {
            if (reports.length > 1) process.stdout.write(`# ${r.loop_name}\n`);
            process.stdout.write(formatReport(r) + "\n");
            if (reports.length > 1) process.stdout.write("\n");
        }
    }
    const worst = reports.reduce<0 | 1 | 2>((acc, r) => {
        const code = exitCodeFor(r);
        if (code === 1) return 1;
        if (code === 2 && acc !== 1) return 2;
        return acc;
    }, 0);
    process.exit(worst);
}

void installRoot; // shut up `unused` (kept for future SHA introspection use)

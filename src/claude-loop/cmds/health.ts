/**
 * `claude-loop health [<name>]` — plomberie diagnostic (#860).
 *
 * 10 checks par loop : loop process + source SHA, loop.sock UDS, proxy
 * alive, tmux session, orphan launcher (#1100), ipc freshness, boot
 * status, aiball daemon, SSE.
 * Sortie text colorée (✅/⚠️/❌) ou `--json`. Exit code = 0 si tout
 * OK, 1 si un check ❌, 2 si au moins un ⚠️.
 *
 * Pure read-only ; aucun side-effect. Réutilise les helpers existants
 * de `state.ts` + le UDS `queryLoopState` du #774.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
    loopPidPath,
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

export function checkLoop(sd: string): HealthCheck {
    const p = probePid(loopPidPath(sd), /kernel\.ts/);
    if (p.pid === null) return { name: "loop", status: "fail", detail: "loop.pid missing / unreadable" };
    if (!p.alive) return { name: "loop", status: "fail", detail: `pid ${p.pid} not running` };
    if (p.cmdline === null) {
        return {
            name: "loop",
            status: "fail",
            detail: `pid ${p.pid} alive but cmdline doesn't match kernel.ts (= pid recycled)`,
        };
    }
    return { name: "loop", status: "ok", detail: `pid ${p.pid} running (tsx + kernel.ts)` };
}

export function checkLoopSource(sd: string): HealthCheck {
    let plate: Plate;
    try { plate = readPlate(sd); }
    catch { return { name: "loop source", status: "warn", detail: "plate.json missing — can't compare SHA" }; }
    const boot = plate.started_at_sha;
    const now = installRootSha();
    if (boot === null || boot === undefined) {
        return { name: "loop source", status: "warn", detail: "plate.started_at_sha unset" };
    }
    if (now === null) {
        return { name: "loop source", status: "warn", detail: `boot SHA ${boot.slice(0, 7)} — current SHA unknown (no .git?)` };
    }
    if (boot === now) return { name: "loop source", status: "ok", detail: `SHA ${now.slice(0, 7)} (current)` };
    return {
        name: "loop source",
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
    lastSseEventAtMs?: number | null;
    sseConnected?: boolean | null;
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

// ---------------------------------------------------------------------------
// #1100 (Slice 1 de #1090) — orphan tmux-launcher detection.
//
// The start path blocks on `spawnSync(MUX_CMD, ["new-session", "-d", …])`.
// When that launcher wedges (tmux server socket stuck, etc.) it can survive
// while the session it was creating is dead / never born — the loop then
// LOOKS started (a tmux process exists) but nothing runs. Detection only
// here (health stays read-only) ; the kill lands in Slice 2 (`--revive`).
//
// Ownership signature : the launcher's cmdline carries our inner bootstrap
// (`source '<STATE_ROOT>/<name>/env' …`), so a cmdline containing STATE_ROOT
// is one of OURS even after the state dir was rm'd. (The #1090 plan said to
// filter on a `cl-*` session prefix, but `tmuxName()` is identity — sessions
// carry no prefix ; the STATE_ROOT marker is the real discriminator.)
// Linux-only, like `sweepOrphans` — /proc scans have no portable equivalent.
// ---------------------------------------------------------------------------

export interface LauncherMatch { pid: number; session: string; }

/** Pure matcher on a raw NUL-separated `/proc/<pid>/cmdline`. Returns the
 *  target session name iff the process is a `tmux new-session -d -s <S>`
 *  launcher (tmux OR psmux, absolute path tolerated). */
export function matchLauncherCmdline(cmdline: string): string | null {
    const argv = cmdline.split("\0").filter((a) => a.length > 0);
    if (argv.length < 5) return null;
    const bin = (argv[0].split(/[\\/]/).pop() ?? "").toLowerCase();
    if (bin !== "tmux" && bin !== "psmux") return null;
    if (argv[1] !== "new-session") return null;
    if (!argv.includes("-d")) return null;
    const si = argv.indexOf("-s");
    if (si < 0 || si + 1 >= argv.length) return null;
    return argv[si + 1];
}

/** Scan /proc for OUR surviving `new-session` launchers (cmdline matches
 *  the launcher shape AND references STATE_ROOT). Read-only, linux-only. */
export function scanLaunchers(): LauncherMatch[] {
    if (process.platform !== "linux") return [];
    const out: LauncherMatch[] = [];
    let entries: string[];
    try { entries = readdirSync("/proc"); }
    catch { return out; }
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
        let cmdline: string;
        try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); }
        catch { continue; } // died / no permission
        const session = matchLauncherCmdline(cmdline);
        if (session === null) continue;
        if (!cmdline.includes(STATE_ROOT)) continue; // not one of ours
        out.push({ pid, session });
    }
    return out;
}

function sessionAlive(session: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", session], { stdio: "ignore" });
    return !r.error && r.status === 0;
}

/** Per-loop probe : a surviving launcher for THIS loop's session while the
 *  session is dead → fail. Deps injectable for tests. */
export function checkOrphanLauncher(
    name: string,
    deps: { scan?: () => LauncherMatch[]; alive?: (s: string) => boolean } = {},
): HealthCheck {
    if (process.platform !== "linux") {
        return { name: "launcher", status: "ok", detail: "n/a (non-linux)" };
    }
    const scan = deps.scan ?? scanLaunchers;
    const alive = deps.alive ?? sessionAlive;
    const t = tmuxName(name);
    const hits = scan().filter((l) => l.session === t);
    if (hits.length === 0) return { name: "launcher", status: "ok", detail: "no orphan launcher" };
    if (alive(t)) {
        // Launcher process present but the session exists — a launch in
        // flight (transient) or tmux keeping the client around. Not an
        // orphan ; no false positive on a live session.
        return { name: "launcher", status: "ok", detail: `launcher pid ${hits[0].pid} present, session alive` };
    }
    const pids = hits.map((h) => h.pid).join(", ");
    return { name: "launcher", status: "fail", detail: `orphan tmux launcher (pid ${pids}) — session dead` };
}

/** Global sweep for the state-dir-rm'd case the per-loop probe can't see
 *  (health is indexed on plate.json) : any of OUR launchers whose session is
 *  dead and which no per-loop report covers. */
export function scanOrphanLaunchers(
    excludeSessions: Set<string>,
    deps: { scan?: () => LauncherMatch[]; alive?: (s: string) => boolean } = {},
): LauncherMatch[] {
    const scan = deps.scan ?? scanLaunchers;
    const alive = deps.alive ?? sessionAlive;
    return scan().filter((l) => !excludeSessions.has(l.session) && !alive(l.session));
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
    // #868 — settleBoot safety cap was dropped : the bus-driven seal can
    // legitimately take 60-120s on a fresh `claude --resume` (picker
    // window + first /compact + 10s tail grace). Reserve `fail` for the
    // truly stuck (= >3min, watchers never fired bootEnded), keep `warn`
    // up to 3min so the watcher path has room.
    if (elapsedMs < 180_000) {
        return { name: "boot status", status: "warn", detail: `boot in progress (elapsed ${(elapsedMs / 1000).toFixed(0)}s)` };
    }
    return {
        name: "boot status",
        status: "fail",
        detail: `stuck in boot ${(elapsedMs / 1000).toFixed(0)}s — watcher path never fired bootEnded ?`,
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

/** #869 — SSE channel check via `ipc.sseConnected` (flipped by `WakeBus`
 *  events). Replaces the flaky time-since-last-event TTL — SSE events
 *  are demand-driven (hello/control/ping), so quiet periods of 10+ min
 *  are normal even when the connection is alive. `lastSseEventAtMs` is
 *  kept for informational age display. */
export function checkSse(live: LiveLoopState | null, nowMs: number = Date.now()): HealthCheck {
    if (live === null) return { name: "SSE channel", status: "fail", detail: "no UDS reply (skipped)" };
    if (live.sseConnected === false) {
        return { name: "SSE channel", status: "fail", detail: "disconnected (WakeBus error — auto-reconnect on next heartbeat)" };
    }
    if (live.sseConnected === null) {
        return { name: "SSE channel", status: "warn", detail: "no connection state yet (still connecting ?)" };
    }
    const ts = live.lastSseEventAtMs ?? null;
    const ageStr = ts !== null ? `, last event ${((nowMs - ts) / 1000).toFixed(0)}s ago` : "";
    return { name: "SSE channel", status: "ok", detail: `connected${ageStr}` };
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
    checks.push(checkLoop(sd));
    checks.push(checkLoopSource(sd));
    const { live, latencyMs, sockMissing } = await queryUdsLoopState(sd);
    checks.push(checkLoopSock(latencyMs, sockMissing, live));
    checks.push(checkProxy(sd));
    checks.push(checkTmuxSession(name));
    checks.push(checkOrphanLauncher(name));
    checks.push(checkIpcFreshness(live));
    checks.push(checkBootStatus(sd, live));
    checks.push(await checkAiballDaemon());
    checks.push(checkSse(live));
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

export async function cmdHealth(target: string | string[] | null | undefined, opts: { json?: boolean }): Promise<void> {
    // #994 — `target` is the explicit loop list resolved by the caller (a
    // single name, the cwd's loops, …). `null`/`undefined` = check every
    // registered loop (the `--all` / no-cwd-loop fallback).
    const names: string[] = [];
    if (typeof target === "string") names.push(target);
    else if (Array.isArray(target)) names.push(...target);
    else {
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
    // #1100 — global sweep : orphan launchers whose state dir was rm'd (no
    // plate.json → no per-loop report). Rendered as a synthetic report so
    // both the text and --json outputs keep one shape, and the exit code
    // reflects the failure.
    const covered = new Set(names.map((n) => tmuxName(n)));
    const strays = scanOrphanLaunchers(covered);
    if (strays.length > 0) {
        reports.push({
            loop_name: "(orphan launchers)",
            state_dir: "",
            exists: false,
            checks: strays.map((l) => ({
                name: "launcher",
                status: "fail" as const,
                detail: `orphan tmux launcher (pid ${l.pid}) for session '${l.session}' — session dead, no registered loop`,
            })),
            summary: { ok: 0, warn: 0, fail: strays.length },
        });
    }
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

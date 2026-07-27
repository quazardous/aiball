/**
 * Lifecycle / state-management commands (carved out of cli.ts in
 * #B.213 phase 2.B on 2026-05-19). Behavior-preserving move.
 *
 * Exports:
 *   - `cmdRm(name, force)`  — kill tmux + timer + remove state dir
 *   - `cmdWake(name)`       — touch the wake-requested marker
 *   - `cmdReload(name)`     — respawn detached timer w/o touching claude
 *   - `cmdPrune()`          — interactively clean orphan state dirs
 *
 * `die`, `tmuxAlive`, `shQuote` are inlined small helpers — same
 * rationale as cmds/tail.ts. `installRoot()` from state.ts replaces
 * the cli.ts-local `selfRoot()` (computes the same value, just lives
 * in state.ts).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
    MUX_CMD,
    STATE_ROOT,
    envPath,
    envLocalPath,
    fetchSnapshotsFromTimer,
    installRoot,
    installRootSha,
    platePath,
    readPlate,
    writePlate,
    stateDirFor,
    loopLogPath,
    loopPidPath,
    tmuxName,
    loopSockPath,
    sendShutdownToTimer,
    zenPath,
    type Plate,
} from "../state.js";
import { RESPAWN_STATE_ENV_VAR, REATTACH_ENV_VAR } from "../respawn-state.js";
import { sendEventOnce } from "../ipc-events.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop: ${msg}\n`);
    process.exit(1);
}

function tmuxAlive(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    return r.status === 0;
}

/**
 * #783 — scan running processes for any timer / proxy / hook still bound to
 * `<sd>` via the `CL_STATE_DIR` env var, SIGKILL them. Catches orphans the
 * watchdog or bash trap couldn't reap (pre-fix code, kill -9 of bash before
 * the trap had wired up, etc.). Linux-only: reads /proc/<pid>/environ. On
 * other platforms the function is a silent no-op — the 2s watchdog covers
 * orphans spawned by post-fix code, and an installed-base sweep needs
 * platform-specific plumbing (mac libproc / windows WMI) we haven't built.
 */
export function sweepOrphans(sd: string, opts: { kernelOnly?: boolean } = {}): { killed: number[] } {
    if (process.platform !== "linux") return { killed: [] };
    const killed: number[] = [];
    const marker = `CL_STATE_DIR=${sd}`;
    let entries: string[];
    try { entries = readdirSync("/proc"); }
    catch { return { killed: [] }; }
    for (const entry of entries) {
        const pid = Number(entry);
        if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;
        let env: string;
        try { env = readFileSync(`/proc/${pid}/environ`, "utf8"); }
        catch { continue; } // process died, or no permission
        // /proc/<pid>/environ is NUL-separated KEY=VAL entries. The match
        // needs to be exact-key, not substring (e.g. CL_STATE_DIR_BACKUP
        // shouldn't false-match), so anchor on `\0KEY=VAL\0` or at the
        // start of the buffer.
        if (!env.includes(`\0${marker}\0`) && !env.startsWith(`${marker}\0`)) continue;
        // #1059 — on a RELOAD the proxy + claude are ALIVE and must survive (the
        // proxy carries CL_STATE_DIR too, so an unfiltered sweep SIGKILLs it →
        // claude's PTY dies = the #1032 "le proxy ne survit pas au reload").
        // `kernelOnly` restricts the kill to sibling kernels (cmdline ~ kernel.ts).
        // cmdStart keeps the full sweep (fresh start — nothing live to protect).
        if (opts.kernelOnly) {
            let cmdline: string;
            try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8"); }
            catch { continue; }
            if (!/kernel\.ts/.test(cmdline)) continue;
        }
        try { process.kill(pid, "SIGKILL"); killed.push(pid); }
        catch { /* race : process already dead */ }
    }
    return { killed };
}

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * #684 — patch `<state_dir>/env` with `KEY=VAL` pairs from `--set` BEFORE
 * the timer respawn. Each pair :
 *  - KEY validated against `^[A-Z_][A-Z0-9_]*$` (env-var name grammar). An
 *    invalid name dies — prevents quote-bypass via `KEY="oops"=foo` etc.
 *  - VAL empty string = drop every `export KEY=...` line (= unset).
 *  - VAL non-empty = drop existing lines for that KEY, append a single
 *    `export KEY=<shQuote(VAL)>` at the bottom (idempotent on re-runs).
 *  - Same KEY appearing multiple times in `set[]` : last wins (we apply
 *    each in order, and each apply normalises duplicates to one line).
 */
function patchEnvSet(envFilePath: string, kvList: string[]): void {
    let lines = readFileSync(envFilePath, "utf8").split("\n");
    for (const kv of kvList) {
        const eq = kv.indexOf("=");
        if (eq <= 0) die(`--set: expected KEY=VAL (got '${kv}')`);
        const key = kv.slice(0, eq);
        const val = kv.slice(eq + 1);
        if (!ENV_VAR_NAME_RE.test(key)) die(`--set: invalid env var name '${key}' (must match [A-Z_][A-Z0-9_]*)`);
        const exportLine = new RegExp(`^export ${key}=`);
        const had = lines.some((l) => exportLine.test(l));
        lines = lines.filter((l) => !exportLine.test(l));
        if (val === "") {
            process.stdout.write(`${envFilePath}: unset ${key}${had ? "" : " (was already absent)"}\n`);
        } else {
            // Strip trailing empty lines so the append lands tight, then
            // re-add one trailing newline at the end.
            while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
            lines.push(`export ${key}=${shQuote(val)}`);
            process.stdout.write(`${envFilePath}: patched ${key}=${val}${had ? " (replaced)" : ""}\n`);
        }
    }
    writeFileSync(envFilePath, lines.join("\n") + "\n");
}

export function cmdRm(name: string, force: boolean): void {
    const sd = stateDirFor(name);
    // #866 Slice 2 — cooperative shutdown via loop.sock avant tout.
    // Au cas où le wrapper-pid #413 ne pointe pas vers le vrai timer,
    // le timer écoute son socket et se kill proprement à réception.
    void sendShutdownToTimer(sd);
    spawnSync(MUX_CMD, ["kill-session", "-t", tmuxName(name)], { stdio: "ignore" });
    if (existsSync(loopPidPath(sd))) {
        try {
            const pid = Number(readFileSync(loopPidPath(sd), "utf8").trim());
            if (Number.isFinite(pid) && pid > 0) process.kill(pid);
        } catch { /* already dead */ }
    }
    if (existsSync(sd)) {
        rmSync(sd, { recursive: true, force: true });
        process.stdout.write(`removed loop '${name}'\n`);
    } else if (!force) {
        die(`no state dir at ${sd} (use --force to silence)`);
    }
}

/**
 * #442: clean STOP — SIGTERM the timer (its handler kills tmux + exits; the
 * state dir is KEPT). The signal mirror of the timer's TERM handler, completing
 * the convention alongside reload (USR2) / restart (HUP). Unlike `rm` (halt +
 * delete), `stop` leaves the loop listed as dead so it stays restart/prune-able.
 */
export function cmdStop(name: string): void {
    const sd = stateDirFor(name);
    if (!existsSync(loopPidPath(sd))) die(`no loop '${name}' at ${sd}`);
    let pid: number | null = null;
    try {
        const raw = Number(readFileSync(loopPidPath(sd), "utf8").trim());
        if (Number.isFinite(raw) && raw > 0) pid = raw;
    } catch { /* unreadable */ }
    if (pid === null) die(`no timer pid recorded for '${name}'`);
    // #866 Slice 2 — cooperative shutdown via loop.sock avant le SIGTERM
    // pid-based (qui peut viser le wrapper tsx au lieu du vrai timer #413).
    void sendShutdownToTimer(sd);
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        die(`timer for '${name}' not running (stale pid ${pid}) — use 'rm' to clean up`);
    }
    process.stdout.write(`stop sent to loop '${name}' (clean shutdown; state kept — 'rm' to delete)\n`);
}

export function cmdWake(name: string): void {
    if (!tmuxAlive(name)) die(`loop '${name}' not alive`);
    const sd = stateDirFor(name);
    // Don't clear idle-since: the timer's first check is
    // `if (!idle-since) continue` — wiping it would make the next
    // tick SKIP instead of fire (regression noted in concept review).
    // We only need wake-requested set; timer reads it as a check-cmd
    // bypass. If claude is mid-turn (no idle-since), wake is queued
    // until claude finishes and the Stop hook decides what to do.
    //
    // #840 `4z59jt` — IPC seul. La CLI émet un marker `set_wake_requested`
    // sur `loop.sock` ; le timer's dispatcher pose `ipc.wakeRequestedAtMs`.
    const atMs = Date.now();
    void sendEventOnce(loopSockPath(sd), {
        kind: "proxyEvent",
        data: { event: "marker", name: "set_wake_requested", at_ms: atMs, now_ms: atMs },
    }, { timeoutMs: 200 });
    const plate = (() => { try { return readPlate(sd); } catch { return null; } })();
    const interval = plate?.interval ?? 60;
    process.stdout.write(
        `wake requested for '${name}' (fires at next timer tick when claude is idle, up to ${interval}s)\n`,
    );
}

/**
 * Respawn just the detached timer process without touching claude.
 * Needed because `tsx` doesn't hot-reload (#B.198): when timer.ts or
 * state.ts changes, the running timer keeps the old code in memory
 * until restarted — but `rm + start` kills claude too, losing the
 * conversation. `reload` kills the recorded timer pid and re-execs a
 * fresh one using the same env file the loop was started with, so the
 * tmux session + claude pane stay intact.
 */
/**
 * #749 david — `claude-loop zen <name>` toggle the wake kill-switch.
 * Touches / removes a marker file the timer checks at the top of every
 * `tryWake`. State-dir scoped (not global), survives `reload`. With
 * `--on` / `--off` to be explicit ; bare = toggle. Verbose enough to
 * see the new state at a glance.
 */
export function cmdZen(name: string, opts?: { on?: boolean; off?: boolean }): void {
    const sd = stateDirFor(name);
    if (!existsSync(sd)) die(`no state dir at ${sd}`);
    const marker = zenPath(sd);
    const isOn = existsSync(marker);
    const explicit = opts?.on === true ? true : (opts?.off === true ? false : null);
    const next = explicit !== null ? explicit : !isOn;
    // #749 — instant bar paint. The chip surfaces in status-right via the
    // `#{@cl_zen}` segment seeded in cli.ts ; setTmuxStatus refreshes it
    // on every heartbeat too, but writing here is what makes the toggle
    // feel snappy from the user's POV.
    const zenChunk = next
        ? `#[fg=colour16,bg=colour208,bold] ZEN #[default] `
        : "";
    spawnSync(MUX_CMD, ["set-option", "-t", tmuxName(name), "@cl_zen", zenChunk], { stdio: "ignore" });
    if (next && !isOn) {
        writeFileSync(marker, new Date().toISOString() + "\n");
        process.stdout.write(`zen ON for '${name}' — all wakes muted (timer reads ${marker} live, no restart needed)\n`);
    } else if (!next && isOn) {
        try { rmSync(marker); } catch { /* ignore */ }
        process.stdout.write(`zen OFF for '${name}' — wakes re-enabled\n`);
    } else {
        process.stdout.write(`zen already ${isOn ? "ON" : "OFF"} for '${name}' — no change\n`);
    }
}

export async function cmdReload(name: string, opts?: { set?: string[] }): Promise<void> {
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use 'start' to spawn a fresh one)`);
    }
    const sd = stateDirFor(name);
    if (!existsSync(platePath(sd))) die(`no state dir at ${sd}`);
    if (!existsSync(envPath(sd))) die(`no env file at ${envPath(sd)} — loop is broken, use rm + start`);

    // #684 david `feb5b4`/`dy54ks` (catchphrase y8rynp) — D1 : `--set KEY=VAL`
    // patches the env file BEFORE respawning the timer, so the fresh process
    // sources the new value. Multiple `--set` allowed (last wins per KEY).
    // VAL="" drops the export line entirely (cohérent avec `unset`). The
    // intended target is the debug-only flags (CL_PANE_CAPTURE_LOG,
    // CL_BAR_PAINT_LOG, CL_PROXY_LOG) that have no yaml backing — pas de
    // restriction sur KEY, mais on valide la grammaire d'un nom d'env var.
    if (opts?.set && opts.set.length > 0) {
        patchEnvSet(envPath(sd), opts.set);
        // #991 — an unset (`KEY=`) must ALSO clear the volatile env.local,
        // otherwise a shell-prefix override living there would survive a
        // `--set KEY=` (and the user couldn't turn it off without rm). Only
        // the empty-value sets are forwarded — non-empty `--set` stays the
        // deliberate-persistent `env` channel.
        const unsets = opts.set.filter((kv) => {
            const eq = kv.indexOf("=");
            return eq > 0 && kv.slice(eq + 1) === "";
        });
        if (unsets.length > 0 && existsSync(envLocalPath(sd))) {
            patchEnvSet(envLocalPath(sd), unsets);
        }
    }

    let oldPid: number | null = null;
    if (existsSync(loopPidPath(sd))) {
        const raw = Number(readFileSync(loopPidPath(sd), "utf8").trim());
        if (Number.isFinite(raw) && raw > 0) oldPid = raw;
    }
    // #943 — capture XState snapshots from the live timer BEFORE we kill
    // it, so the new spawn restores exact controller state (AFK wait_inf
    // survives reload — pre-fix it reverted to off). Symmetric to
    // `selfReloadIfStale` which does the same in-process. Best-effort :
    // null on any failure (timer already dying, socket missing, ws drop)
    // → new spawn cold-boots (= pre-fix behavior). Must run BEFORE
    // `sendShutdownToTimer` since the timer closes its server on
    // shutdown frame receipt and the round-trip would race.
    const snapshotsJson = await fetchSnapshotsFromTimer(sd, 500);
    // #866 Slice 2 — cooperative shutdown via loop.sock BEFORE the SIGKILL
    // fallback. Le timer cible (le VRAI process timer.ts, pas le wrapper
    // tsx zombie #413) écoute son propre socket et se kill proprement à
    // réception du frame. Fire-and-forget : on n'attend pas la mort, on
    // continue avec SIGKILL au cas où le timer ignore le shutdown frame
    // (vieux timer pré-#866, socket déjà fermé, etc.).
    void sendShutdownToTimer(sd);
    if (oldPid !== null) {
        // #780 — SIGKILL not SIGTERM. The SIGTERM handler in timer.ts runs
        // `cleanShutdown` which also kills the tmux session — we DON'T want
        // that during a reload (the whole point of reload vs restart is to
        // keep claude alive). SIGKILL skips the handler; the new timer's
        // boot rewrites loop.pid + reattaches loop.sock; the post-#783
        // watchdog on the new process means stale markers are reaped
        // naturally on the next 2s tick.
        try { process.kill(oldPid, "SIGKILL"); } catch { /* already dead */ }
    }
    // #783 — sweep any other orphan tied to this state-dir (extra timer
    // forks left by tsx-watch reload races, half-dead proxy from a previous
    // crash). No-op on platforms without /proc.
    // #1059 — kernelOnly : a reload must NOT sweep the live proxy/claude (they
    // carry CL_STATE_DIR too) ; only sibling kernels are orphans here.
    const swept = sweepOrphans(sd, { kernelOnly: true });
    if (swept.killed.length > 0) {
        process.stdout.write(`claude-loop: swept ${swept.killed.length} orphan kernel(s) bound to '${sd}' before reload\n`);
    }

    // #251: re-stamp the plate's source SHA so a reloaded loop drops the
    // `[stale]` chip in `list` (and won't immediately self-reload). The
    // fresh timer is loaded from the current source, so it IS in sync.
    try {
        const plate = readPlate(sd);
        const sha = installRootSha();
        if (sha && plate.started_at_sha !== sha) {
            plate.started_at_sha = sha;
            writePlate(sd, plate);
        }
    } catch { /* no plate / not a git checkout — leave staleness as-is */ }

    const root = installRoot();
    const logFd = openSync(loopLogPath(sd), "a");
    // The detached timer entrypoint is kernel.ts (NOT timer.ts — that file
    // doesn't exist; the cold-start path spawns kernel.ts too, cli.ts). Pointing
    // reload at timer.ts crashed the respawn with ERR_MODULE_NOT_FOUND → the
    // old timer was SIGKILL'd but no new one came up → loop dead on every reload.
    const timerScript = join(root, "src/claude-loop/kernel.ts");
    // #B.228: call tsx via absolute path so reload works from any cwd
    // (npx --no-install would fail when reload is invoked from a project
    // dir without tsx in its own node_modules, same as the SessionStart
    // hook bug that motivated the change in cli.ts cmdStart).
    const tsxBin = shQuote(join(root, "node_modules", ".bin", "tsx"));
    // #943 — pass the captured XState snapshots via env so the new timer's
    // service factories restore the exact state (cf. `consumePendingSnapshot`
    // in afk-service.ts etc.). Null = nothing to preserve, cold boot.
    // #1059 — REATTACH marks the new kernel as resuming a live claude (no
    // bootstrap re-inject ; seed NOT-AFK-10min if the AFK snapshot is lost).
    const spawnEnv = snapshotsJson
        ? { ...process.env, [RESPAWN_STATE_ENV_VAR]: snapshotsJson, [REATTACH_ENV_VAR]: "1" }
        : { ...process.env, [REATTACH_ENV_VAR]: "1" };
    const child = spawn("bash", [
        "-lc",
        // #991 — preserve + re-source the volatile env.local across a reload
        // (timer respawn keeps the debug-session shell overrides).
        `source ${shQuote(envPath(sd))}; [ -f ${shQuote(envLocalPath(sd))} ] && source ${shQuote(envLocalPath(sd))}; exec ${tsxBin} ${shQuote(timerScript)}`,
    ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: spawnEnv,
    });
    child.unref();
    writeFileSync(loopPidPath(sd), String(child.pid) + "\n");

    const killed = oldPid !== null ? ` (killed old pid ${oldPid})` : "";
    const restored = snapshotsJson ? " (xstate snapshots restored)" : "";
    process.stdout.write(`timer for '${name}' respawned${killed}${restored} — new pid ${child.pid}\n`);
}

/**
 * #388: HARD restart — kill the loop entirely (claude + tmux session + timer +
 * state) and relaunch it fresh with the SAME start config. Unlike `reload`
 * (timer-only, claude survives), this is the "stop + start" david asked for.
 *
 * The config is read from the plate BEFORE the rm (rm deletes the state dir).
 * The relaunch goes through the real `claude-loop start` (spawned detached in
 * the loop's original cwd) so the full start path + ctx resolution is reused —
 * `--no-attach` because a restart has no TTY to attach to (reconnect with
 * `claude-loop attach <name>`). Doubles as the SIGHUP self-restart action: the
 * timer traps SIGHUP and spawns THIS detached, so it survives killing its own
 * session.
 */
/**
 * Rebuild the `start` invocation a restart must replay, from the plate alone.
 *
 * Pure and exported so the replay is testable without spawning anything — the
 * same split `crew.ts` uses (planning layer tested, git/spawn calls kept thin).
 * #1576 is precisely a bug of omission in this list, and an omission is only
 * visible in a test if the list is a value rather than an inline literal.
 *
 * Not recoverable from the plate, by design: the pings source
 * (`plate.pings_path` points into the state dir we're about to rm), so the
 * relaunch falls back to the default ping phrases.
 */
export function restartStartArgs(name: string, plate: Plate): string[] {
    // #1576 — the launch identity, top-level, independent of `remote`. Falls
    // back to the remote block for plates written before the top-level fields
    // existed, so an older remote loop keeps replaying what it used to.
    const consumer = plate.consumer ?? plate.remote?.consumer ?? null;
    const project = plate.project ?? plate.remote?.project ?? null;
    return [
        "start",
        "--name", name,
        "--interval", String(plate.interval),
        "--check-cmd", plate.check_cmd,
        // #390: replay the remote-daemon connection so a hard restart of a
        // remote loop stays remote (else it would fall back to a local socket).
        ...(plate.remote?.url ? ["--aiball-url", plate.remote.url] : []),
        ...(plate.remote?.token ? ["--aiball-token", plate.remote.token] : []),
        // #1576: a crew loop carries these WITHOUT any remote. Dropping them
        // brought it back as the lead — able to claim, under the lead's
        // identity, because the worktree has no `.aiball.yaml` of its own and
        // the config walk-up reaches the lead's.
        ...(plate.role ? ["--role", plate.role] : []),
        ...(consumer ? ["--consumer", consumer] : []),
        ...(project ? ["--project", project] : []),
        "--force",
        "--no-attach",
        ...(plate.claude_args.length ? ["--", ...plate.claude_args] : []),
    ];
}

export function cmdRestart(name: string): void {
    const sd = stateDirFor(name);
    if (!existsSync(platePath(sd))) {
        die(`no loop '${name}' to restart (no state dir at ${sd}) — use 'start'`);
    }
    const plate = readPlate(sd);
    const bin = join(installRoot(), "bin", "claude-loop");
    const startArgs = restartStartArgs(name, plate);
    // Delegate the teardown+relaunch to a DETACHED, new-session helper (setsid
    // via detached:true). This is what lets a HARD restart survive being fired
    // from INSIDE the very session it kills — by the SIGHUP'd timer, OR by the
    // loop's own claude bash (an agent restarting itself). The invoker dies
    // during `rm` (tmux kill-session), but this child — a new session, outside
    // the tmux pane's process group — does not. The brief sleep lets the invoker
    // return first so the kill is clean. rm + start run as fresh CLI subprocesses.
    // #407 (fiabiliser): send the helper's whole output to a log OUTSIDE the
    // rm'd state dir — the old `>/dev/null` + `stdio:"ignore"` hid every failure
    // (rm, start, lock), so a botched restart left the loop dead silently.
    const logPath = join(STATE_ROOT, "restart.log");
    const script =
        `exec >> ${shQuote(logPath)} 2>&1; ` +
        `echo "$(date -Is) [${name}] restart: rm + start (cwd ${plate.cwd})"; ` +
        `sleep 0.4; ${shQuote(bin)} rm ${shQuote(name)} --force; ` +
        `exec ${shQuote(bin)} ${startArgs.map(shQuote).join(" ")}`;
    const child = spawn("bash", ["-lc", script], {
        cwd: plate.cwd,
        detached: true,
        stdio: "ignore",
    });
    child.unref();
    process.stdout.write(
        `restart scheduled for '${name}' — detached helper (pid ${child.pid}) will kill + relaunch in ${plate.cwd}. Reconnect: 'claude-loop attach ${name}'.\n`,
    );
}

export async function cmdPrune(): Promise<void> {
    if (!existsSync(STATE_ROOT)) {
        process.stdout.write("nothing to prune\n");
        return;
    }
    const orphans: string[] = [];
    for (const name of readdirSync(STATE_ROOT)) {
        if (!tmuxAlive(name)) orphans.push(name);
    }
    if (orphans.length === 0) {
        process.stdout.write("nothing to prune\n");
        return;
    }
    process.stdout.write(`orphan state dirs (no tmux): ${orphans.join(" ")}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("remove them? [y/N] ");
    rl.close();
    if (!/^[Yy]$/.test(ans.trim())) {
        process.stdout.write("aborted\n");
        return;
    }
    for (const n of orphans) {
        rmSync(stateDirFor(n), { recursive: true, force: true });
    }
    process.stdout.write(`pruned ${orphans.length} orphan(s)\n`);
}

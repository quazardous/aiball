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
    installRoot,
    installRootSha,
    platePath,
    readPlate,
    writePlate,
    stateDirFor,
    timerLogPath,
    timerPidPath,
    tmuxName,
    wakeRequestedPath,
} from "../state.js";

function die(msg: string): never {
    process.stderr.write(`claude-loop: ${msg}\n`);
    process.exit(1);
}

function tmuxAlive(name: string): boolean {
    const r = spawnSync(MUX_CMD, ["has-session", "-t", tmuxName(name)], { stdio: "ignore" });
    return r.status === 0;
}

function shQuote(s: string): string {
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

export function cmdRm(name: string, force: boolean): void {
    const sd = stateDirFor(name);
    spawnSync(MUX_CMD, ["kill-session", "-t", tmuxName(name)], { stdio: "ignore" });
    if (existsSync(timerPidPath(sd))) {
        try {
            const pid = Number(readFileSync(timerPidPath(sd), "utf8").trim());
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

export function cmdWake(name: string): void {
    if (!tmuxAlive(name)) die(`loop '${name}' not alive`);
    const sd = stateDirFor(name);
    // Don't clear idle-since: the timer's first check is
    // `if (!idle-since) continue` — wiping it would make the next
    // tick SKIP instead of fire (regression noted in concept review).
    // We only need wake-requested set; timer reads it as a check-cmd
    // bypass. If claude is mid-turn (no idle-since), wake is queued
    // until claude finishes and the Stop hook decides what to do.
    writeFileSync(wakeRequestedPath(sd), new Date().toISOString());
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
export function cmdReload(name: string): void {
    if (!tmuxAlive(name)) {
        die(`loop '${name}' not alive (use 'start' to spawn a fresh one)`);
    }
    const sd = stateDirFor(name);
    if (!existsSync(platePath(sd))) die(`no state dir at ${sd}`);
    if (!existsSync(envPath(sd))) die(`no env file at ${envPath(sd)} — loop is broken, use rm + start`);

    let oldPid: number | null = null;
    if (existsSync(timerPidPath(sd))) {
        const raw = Number(readFileSync(timerPidPath(sd), "utf8").trim());
        if (Number.isFinite(raw) && raw > 0) oldPid = raw;
    }
    if (oldPid !== null) {
        try { process.kill(oldPid); } catch { /* already dead */ }
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
    const logFd = openSync(timerLogPath(sd), "a");
    const timerScript = join(root, "src/claude-loop/timer.ts");
    // #B.228: call tsx via absolute path so reload works from any cwd
    // (npx --no-install would fail when reload is invoked from a project
    // dir without tsx in its own node_modules, same as the SessionStart
    // hook bug that motivated the change in cli.ts cmdStart).
    const tsxBin = shQuote(join(root, "node_modules", ".bin", "tsx"));
    const child = spawn("bash", [
        "-lc",
        `source ${shQuote(envPath(sd))} && exec ${tsxBin} ${shQuote(timerScript)}`,
    ], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    writeFileSync(timerPidPath(sd), String(child.pid) + "\n");

    const killed = oldPid !== null ? ` (killed old pid ${oldPid})` : "";
    process.stdout.write(`timer for '${name}' respawned${killed} — new pid ${child.pid}\n`);
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
export function cmdRestart(name: string): void {
    const sd = stateDirFor(name);
    if (!existsSync(platePath(sd))) {
        die(`no loop '${name}' to restart (no state dir at ${sd}) — use 'start'`);
    }
    const plate = readPlate(sd);
    const bin = join(installRoot(), "bin", "claude-loop");
    // Reconstruct the original `start` invocation from the persisted plate.
    // (pings source isn't recoverable from the plate — plate.pings_path points
    // into the state dir we're about to rm — so the relaunch falls back to the
    // default ping phrases, which is fine for a restart.)
    const startArgs = [
        "start",
        "--name", name,
        "--interval", String(plate.interval),
        "--check-cmd", plate.check_cmd,
        "--force",
        "--no-attach",
        ...(plate.claude_args.length ? ["--", ...plate.claude_args] : []),
    ];
    // Delegate the teardown+relaunch to a DETACHED, new-session helper (setsid
    // via detached:true). This is what lets a HARD restart survive being fired
    // from INSIDE the very session it kills — by the SIGHUP'd timer, OR by the
    // loop's own claude bash (an agent restarting itself). The invoker dies
    // during `rm` (tmux kill-session), but this child — a new session, outside
    // the tmux pane's process group — does not. The brief sleep lets the invoker
    // return first so the kill is clean. rm + start run as fresh CLI subprocesses.
    const script =
        `sleep 0.4; ${shQuote(bin)} rm ${shQuote(name)} --force >/dev/null 2>&1; ` +
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

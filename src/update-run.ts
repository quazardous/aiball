/**
 * #2588 — `aiball update`: run the update the way this machine was installed.
 *
 * The steps are `updateSteps` (src/install-info.ts), the same list
 * `aiball version` shows. What this module adds is the part that must not be
 * improvised in a desktop menu:
 *   - refusals: no recorded install; a dev checkout that is dirty or not on
 *     `main` (the runtime checkout's branch is never switched, nothing stashed);
 *   - a log (`$AIBALL_HOME/update.log`) and a status file
 *     (`$AIBALL_HOME/update-status.json`) the tray and the extension read to
 *     say how it ended;
 *   - on Windows, a runner script outside the install dir. `install.ps1`
 *     replaces that directory and the tray owns the daemon, so neither this
 *     process nor the tray may still be running when it does: the tray stops
 *     the daemon and quits, the runner runs the steps and relaunches the tray,
 *     which starts the daemon again — whether the update succeeded or not.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type InstallInfo, type UpdateStep, updateCommand, updateSteps } from "./install-info.js";

export interface GitState {
    branch: string | null;
    /** Tracked changes only: an untracked file never blocks a fast-forward. */
    dirty: boolean;
}

export type UpdatePlan =
    | { ok: true; mode: InstallInfo["mode"]; source: string; steps: UpdateStep[]; command: string }
    | { ok: false; mode: InstallInfo["mode"]; reason: string; command: string };

/** Pure: may this install be updated from here, and with which steps. */
export function planUpdate(info: InstallInfo, git: GitState | null): UpdatePlan {
    const command = updateCommand(info);
    const steps = updateSteps(info);
    if (info.mode === "unknown" || !steps || !info.source) {
        return {
            ok: false, mode: info.mode, command,
            reason: "this install was made before the installer recorded how — re-run the installer once, by hand",
        };
    }
    if (info.mode === "dev") {
        if (!git) return { ok: false, mode: info.mode, command, reason: `${info.source} is not a git checkout` };
        if (git.branch !== "main") {
            return { ok: false, mode: info.mode, command, reason: `the checkout is on ${git.branch ?? "a detached HEAD"}, not main — the update never switches its branch` };
        }
        if (git.dirty) {
            return { ok: false, mode: info.mode, command, reason: "the checkout has uncommitted changes — commit or revert them first; the update never stashes" };
        }
    }
    return { ok: true, mode: info.mode, source: info.source, steps, command };
}

export function readGitState(dir: string): GitState | null {
    const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch.status !== 0) return null;
    const status = git(["status", "--porcelain", "--untracked-files=no"]);
    const name = branch.stdout.trim();
    return { branch: name === "HEAD" ? null : name, dirty: status.status !== 0 || status.stdout.trim() !== "" };
}

export interface UpdateStatus {
    state: "running" | "ok" | "failed";
    mode: InstallInfo["mode"];
    started_at: string;
    finished_at: string | null;
    /** The step that failed, as shown to a human. */
    failed_step: string | null;
    error: string | null;
    log: string;
}

export function updatePaths(home = process.env.AIBALL_HOME || join(homedir(), ".local", "share", "aiball")) {
    return { log: join(home, "update.log"), status: join(home, "update-status.json") };
}

export function readUpdateStatus(path = updatePaths().status): UpdateStatus | null {
    try {
        return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as UpdateStatus;
    } catch {
        return null;
    }
}

function writeStatus(path: string, status: UpdateStatus): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(status, null, 2) + "\n");
}

const shown = (s: UpdateStep) => s.display ?? s.argv.join(" ");

/**
 * Run the steps in order, each one's output appended to the log; stop at the
 * first that fails. Resolves with the final status, which is also on disk.
 */
export async function runUpdate(
    plan: Extract<UpdatePlan, { ok: true }>,
    paths = updatePaths(),
    now: () => Date = () => new Date(),
): Promise<UpdateStatus> {
    mkdirSync(dirname(paths.log), { recursive: true });
    const status: UpdateStatus = {
        state: "running", mode: plan.mode, started_at: now().toISOString(), finished_at: null,
        failed_step: null, error: null, log: paths.log,
    };
    writeStatus(paths.status, status);
    appendFileSync(paths.log, `\n=== aiball update (${plan.mode}) in ${plan.source} — ${status.started_at}\n`);
    for (const step of plan.steps) {
        appendFileSync(paths.log, `\n$ ${shown(step)}\n`);
        const code = await new Promise<number | string>((resolve) => {
            const child = spawn(step.argv[0], step.argv.slice(1), { cwd: plan.source, stdio: ["ignore", "pipe", "pipe"] });
            child.stdout.on("data", (b) => appendFileSync(paths.log, b));
            child.stderr.on("data", (b) => appendFileSync(paths.log, b));
            child.on("error", (e) => resolve(e.message));
            child.on("close", (c) => resolve(c ?? 1));
        });
        if (code !== 0) {
            status.state = "failed";
            status.failed_step = shown(step);
            status.error = typeof code === "string" ? code : `exited with ${code}`;
            break;
        }
    }
    if (status.state === "running") status.state = "ok";
    status.finished_at = now().toISOString();
    appendFileSync(paths.log, `\n=== ${status.state}${status.error ? `: ${status.failed_step} ${status.error}` : ""} — ${status.finished_at}\n`);
    writeStatus(paths.status, status);
    return status;
}

function psq(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The Windows runner: a PowerShell script written OUTSIDE the install dir and
 * started detached, so `install.ps1` can replace that dir. The restart step is
 * left out: the tray stopped the daemon before quitting, and relaunching the
 * tray at the end starts it on the new code.
 */
export function windowsRunnerScript(
    plan: Extract<UpdatePlan, { ok: true }>,
    paths: { log: string; status: string },
    trayCmd: string | null,
): string {
    const steps = plan.steps.filter((s) => !s.restart);
    const lines = [
        "# Generated by `aiball update`: runs the update, then relaunches the tray.",
        "$ErrorActionPreference = 'Continue'",
        `$log = ${psq(paths.log)}`,
        `$statusPath = ${psq(paths.status)}`,
        `$status = [ordered]@{ state = 'running'; mode = ${psq(plan.mode)}; started_at = (Get-Date).ToUniversalTime().ToString('o'); finished_at = $null; failed_step = $null; error = $null; log = $log }`,
        "New-Item -ItemType Directory -Force -Path (Split-Path $log -Parent) | Out-Null",
        "function Save-Status { $status | ConvertTo-Json | Set-Content -Encoding utf8 $statusPath }",
        "Save-Status",
        `Add-Content -Path $log -Encoding utf8 -Value "\`n=== aiball update (${plan.mode}) in ${plan.source.replace(/"/g, "'")} - $($status.started_at)"`,
        `Set-Location -LiteralPath ${psq(plan.source)}`,
        "$steps = @(",
        ...steps.map((s) => `    ,@(${s.argv.map(psq).join(", ")})`),
        ")",
        "foreach ($step in $steps) {",
        "    $shown = $step -join ' '",
        "    Add-Content -Path $log -Encoding utf8 -Value \"`n`$ $shown\"",
        "    try {",
        "        $exe = $step[0]; $rest = @($step | Select-Object -Skip 1)",
        "        & $exe @rest 2>&1 | ForEach-Object { \"$_\" } | Add-Content -Path $log -Encoding utf8",
        "        $code = $LASTEXITCODE",
        "    } catch { $code = $_.Exception.Message }",
        "    if ($code -ne 0) { $status.state = 'failed'; $status.failed_step = $shown; $status.error = \"exited with $code\"; break }",
        "}",
        "if ($status.state -eq 'running') { $status.state = 'ok' }",
        "$status.finished_at = (Get-Date).ToUniversalTime().ToString('o')",
        "Add-Content -Path $log -Encoding utf8 -Value \"`n=== $($status.state) - $($status.finished_at)\"",
        "Save-Status",
    ];
    if (trayCmd) {
        lines.push(
            "# Whatever happened, bring aiball back: the tray starts the daemon (its mutex dedups a second one).",
            `if (Test-Path ${psq(trayCmd)}) { Start-Process -FilePath ${psq(trayCmd)} -WindowStyle Hidden }`,
        );
    }
    return lines.join("\r\n") + "\r\n";
}

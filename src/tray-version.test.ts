/**
 * #2586 — the Windows tray words the versions from `aiball --json version`.
 * The wording lives in bin/aiball-tray-version.ps1, free of WinForms, so it runs
 * here under pwsh (skipped where pwsh is absent). What must hold: the same
 * states as the GNOME extension, the update command only when an update is out,
 * a tooltip within NotifyIcon's 63 characters, and ASCII-only files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BIN = join(import.meta.dirname, "..", "bin");
const LOOKS = join(BIN, "aiball-tray-version.ps1");
const hasPwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

function pwshJson(script: string): unknown {
    const r = spawnSync("pwsh", ["-NoProfile", "-Command", `. '${LOOKS}'; ${script}`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}

test("the tray files stay ASCII, and the tray dot-sources the wording", () => {
    for (const f of ["aiball-tray.ps1", "aiball-tray-version.ps1"]) {
        assert.doesNotMatch(readFileSync(join(BIN, f), "utf8"), /[^\x00-\x7F]/, f);
    }
    assert.match(readFileSync(join(BIN, "aiball-tray.ps1"), "utf8"), /\. \(Join-Path \$PSScriptRoot 'aiball-tray-version\.ps1'\)/);
});

test("the tray's version line, update command and tooltip", { skip: !hasPwsh && "pwsh not installed" }, () => {
    const daemon = { running: "0.41.0", installed: "0.41.0", latest: "0.42.0", release_url: "https://gh/r", error: null, update_available: true, restart_needed: false, check_disabled: false };
    const cli = JSON.stringify({ cli: "0.41.0", daemon, update_command: "Set-Location C:\\a; git pull --ff-only --tags; .\\install.ps1" }).replace(/'/g, "''");
    const out = pwshJson(`$l = Get-VersionLook ('${cli}' | ConvertFrom-Json); @{ look = $l; tip = (Get-TrayTooltip 'running' $l 'http://127.0.0.1:7777') } | ConvertTo-Json -Compress`) as
        { look: { line: string; command: string; releaseUrl: string; notifyKey: string }; tip: string };
    assert.equal(out.look.line, "aiball 0.41.0 - 0.42.0 is available");
    assert.equal(out.look.command, "Set-Location C:\\a; git pull --ff-only --tags; .\\install.ps1");
    assert.equal(out.look.releaseUrl, "https://gh/r");
    assert.equal(out.look.notifyKey, "0.42.0");
    assert.ok(out.tip.length <= 63, out.tip);
    assert.equal(out.tip, "aiball 0.41.0 - running, 0.42.0 available");

    const current = pwshJson(`(Get-VersionLook ('${cli.replace('"update_available":true', '"update_available":false').replace('"latest":"0.42.0"', '"latest":"0.41.0"')}' | ConvertFrom-Json)) | ConvertTo-Json -Compress`) as
        { line: string; command: string | null; notifyKey: string | null };
    assert.equal(current.line, "aiball 0.41.0 - up to date");
    assert.equal(current.command, null);
    assert.equal(current.notifyKey, null);

    const unknown = pwshJson(`@{ tip = (Get-TrayTooltip 'running' (Get-VersionLook $null) 'http://127.0.0.1:7777'); line = (Get-VersionLook $null).line } | ConvertTo-Json -Compress`) as { tip: string; line: string };
    assert.equal(unknown.line, "version unknown");
    assert.equal(unknown.tip, "aiball - running (http://127.0.0.1:7777)");
});

test("the tray's install confirmation and its after-update balloon", { skip: !hasPwsh && "pwsh not installed" }, () => {
    const dry = JSON.stringify({ ok: true, mode: "edge", command: "Set-Location C:\\a; git pull --ff-only --tags; .\\install.ps1", loops: ["a-claude"] }).replace(/'/g, "''");
    const go = pwshJson(`Get-InstallConfirmation ('${dry}' | ConvertFrom-Json) | ConvertTo-Json -Compress`) as { ok: boolean; text: string };
    assert.equal(go.ok, true);
    assert.match(go.text, /disconnects 1 agent loop\(s\) \(a-claude\)/);
    assert.match(go.text, /aiball closes now and comes back/);
    const no = pwshJson(`Get-InstallConfirmation ('{"ok":false,"reason":"no record","command":"re-run"}' | ConvertFrom-Json) | ConvertTo-Json -Compress`) as { ok: boolean; text: string };
    assert.equal(no.ok, false);
    assert.match(no.text, /Cannot update from here: no record/);

    const st = JSON.stringify({ state: "failed", finished_at: "2026-09-16T10:00:00Z", failed_step: "npm install", error: "exited with 1", log: "C:\\h\\update.log" });
    const first = pwshJson(`@{ t = (Get-UpdateResultBalloon ('${st}' | ConvertFrom-Json) $null) } | ConvertTo-Json -Compress`) as { t: string };
    assert.match(first.t, /failed at npm install \(exited with 1\)/);
    const again = pwshJson(`$s = ('${st}' | ConvertFrom-Json); @{ t = (Get-UpdateResultBalloon $s ([string]$s.finished_at)) } | ConvertTo-Json -Compress`) as { t: string | null };
    assert.equal(again.t, null, "shown once");
    const running = pwshJson(`@{ t = (Get-UpdateResultBalloon ('{"state":"running","finished_at":null}' | ConvertFrom-Json) $null) } | ConvertTo-Json -Compress`) as { t: string | null };
    assert.equal(running.t, null);
});

test("the tray stops the daemon and quits before the update runs, and reports the last run at start", () => {
    const tray = readFileSync(join(BIN, "aiball-tray.ps1"), "utf8");
    const fn = tray.slice(tray.indexOf("function Start-UpdateInstall"), tray.indexOf("# The last update's outcome"));
    const order = ["Get-InstallConfirmation", "YesNo", "Stop-Daemon", "update --yes", "Application]::Exit()"].map((k) => fn.indexOf(k));
    assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order, "confirm, then stop the daemon, then hand over, then quit");
    assert.match(tray, /Update-State\r?\nShow-UpdateResult/);
});

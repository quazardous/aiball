#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install / uninstall aiball on Windows (#B.178).

.DESCRIPTION
    Mirror of install.sh, scoped to the daemon + aiball CLI + aiball-mcp.
    claude-loop is not installed (requires tmux — use WSL2 if needed).

    What it does:
      1. Verifies prereqs (node, npm, git).
      2. npm install + frontend build.
      3. Copies (or symlinks with --Symlink) to %LOCALAPPDATA%\Programs\aiball.
      4. Writes .cmd shims in %LOCALAPPDATA%\Microsoft\WindowsApps for
         aiball + aiball-mcp.
      5. Registers a per-user Scheduled Task `aiball-daemon` (starts at
         logon, restarts on failure).
      6. Optionally runs --AuthInit to mint the install token + print
         the setup URL.

.PARAMETER Symlink
    Dev install: symlink %LOCALAPPDATA%\Programs\aiball to this checkout
    instead of copying. Requires Developer Mode (Settings → Update &
    Security → For Developers) OR running as Administrator.

.PARAMETER AuthInit
    After install, mint a one-time install token and print the setup URL
    (equivalent of install.sh --auth-init).

.PARAMETER Uninstall
    Remove shims, scheduled task, and the install dir. Leaves the data
    dir (%APPDATA%\aiball) untouched — pass --PurgeData to wipe it too.

.PARAMETER PurgeData
    With --Uninstall, also delete %APPDATA%\aiball (DB + uploads). Asks
    for confirmation unless --Yes is passed.

.PARAMETER Port
    Daemon TCP port. Default 7777.

.EXAMPLE
    PS> .\install.ps1
    Fresh user install.

.EXAMPLE
    PS> .\install.ps1 -Symlink -AuthInit
    Dev install + mint setup URL.

.EXAMPLE
    PS> .\install.ps1 -Uninstall
    Remove install + scheduled task; keep data.
#>

[CmdletBinding()]
param(
    [switch] $Symlink,
    [switch] $AuthInit,
    [switch] $Uninstall,
    [switch] $PurgeData,
    [switch] $Yes,
    [int]    $Port = 7777
)

$ErrorActionPreference = 'Stop'

# --- paths ------------------------------------------------------------------

$SrcDir    = $PSScriptRoot
$PrefixLib = Join-Path $env:LOCALAPPDATA 'Programs\aiball'
$PrefixBin = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'   # on PATH by default
$DataDir   = Join-Path $env:APPDATA      'aiball'
$LogFile   = Join-Path $env:LOCALAPPDATA 'aiball\daemon.log'
$TaskName  = 'aiball-daemon'

# --- helpers ----------------------------------------------------------------

function Log($msg)  { Write-Host "[aiball] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[aiball] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[aiball] $msg" -ForegroundColor Red; exit 1 }

function Require-Cmd($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Die "missing prerequisite: $name. Install via winget (see docs\WIN-INSTALL.md)."
    }
}

# --- uninstall path ---------------------------------------------------------

if ($Uninstall) {
    Log "stopping scheduled task $TaskName (if present)"
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    foreach ($shim in @('aiball.cmd', 'aiball-mcp.cmd')) {
        $path = Join-Path $PrefixBin $shim
        if (Test-Path $path) {
            Remove-Item $path -Force
            Log "removed shim: $path"
        }
    }

    if (Test-Path $PrefixLib) {
        Remove-Item -Recurse -Force $PrefixLib
        Log "removed install dir: $PrefixLib"
    }

    if ($PurgeData -and (Test-Path $DataDir)) {
        if (-not $Yes) {
            $resp = Read-Host "delete data dir $DataDir (DB + uploads)? [y/N]"
            if ($resp -notmatch '^[yY]') { Warn "kept data dir"; exit 0 }
        }
        Remove-Item -Recurse -Force $DataDir
        Log "removed data dir: $DataDir"
    } elseif (Test-Path $DataDir) {
        Warn "data dir kept at $DataDir (pass --PurgeData to remove)"
    }
    exit 0
}

# --- install path -----------------------------------------------------------

Require-Cmd node
Require-Cmd npm
Require-Cmd git

# TODO(#B.178): minimum node version check (>=18).

Log "running npm install in $SrcDir"
Push-Location $SrcDir
try {
    npm install --no-audit --no-fund
    Log "building frontend"
    Push-Location frontend
    try {
        npm install --no-audit --no-fund
        npm run build
    } finally { Pop-Location }
} finally { Pop-Location }

# TODO(#B.178): provision install dir.
# - If Symlink: New-Item -ItemType SymbolicLink -Path $PrefixLib -Target $SrcDir
#   (needs admin OR developer mode — detect + nudge).
# - Else: Copy-Item -Recurse $SrcDir $PrefixLib (excluding node_modules
#   of devDependencies if separate).
Warn "TODO: install dir provisioning ($PrefixLib) — Copy-Item / New-Item -SymbolicLink"

# TODO(#B.178): write .cmd shims.
# Each shim is one line: @"%LOCALAPPDATA%\Programs\aiball\bin\<name>"
# %* . The .cmd extension survives Windows PATH lookup without needing
# the bash launcher.
Warn "TODO: write $PrefixBin\aiball.cmd + aiball-mcp.cmd shims"

# TODO(#B.178): register the scheduled task.
# Equivalent (rough):
#   $action  = New-ScheduledTaskAction -Execute 'npx.cmd' `
#                  -Argument "--no-install tsx $PrefixLib\src\daemon.ts" `
#                  -WorkingDirectory $PrefixLib
#   $trigger = New-ScheduledTaskTrigger -AtLogon
#   $settings= New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
#   Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings
# Plus a wrapper that redirects stdout/stderr to $LogFile.
Warn "TODO: register scheduled task $TaskName"

# TODO(#B.178): create $DataDir if missing.
# New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# New-Item -ItemType Directory -Force -Path (Split-Path $LogFile -Parent) | Out-Null
Warn "TODO: ensure data + log dirs exist ($DataDir, $(Split-Path $LogFile -Parent))"

# --- post-install -----------------------------------------------------------

if ($AuthInit) {
    # TODO(#B.178): mint a one-time install token + print the setup URL.
    # On the Linux side: `aiball auth init`. Same CLI works on Windows
    # once the shims are in place.
    Warn "TODO: $PrefixBin\aiball.cmd auth init (after shims wired)"
}

Log "scaffold complete. Daemon port: $Port. See docs\WIN-INSTALL.md."
Log "open http://127.0.0.1:$Port once the daemon is running."

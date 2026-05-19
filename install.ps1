#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install / uninstall aiball on Windows (#B.178).

.DESCRIPTION
    Mirror of install.sh, scoped to the daemon + aiball CLI + aiball-mcp.
    claude-loop is also packaged (bin/claude-loop.cmd ships) but the loop
    wrapper itself requires tmux and stays POSIX-only — the .cmd shim is
    there for parity, not for use, until the psmux adapter lands (#B.178).

    What it does:
      1. Verifies prereqs (node>=20, npm, git) + warns on Node>=24
         (better-sqlite3 prebuilt bindings lag — see WIN-INSTALL.md).
      2. Provisions %LOCALAPPDATA%\Programs\aiball (Copy-Item, or
         New-Item -SymbolicLink with --Symlink + dev-mode/admin).
      3. npm install + frontend build in the install dir.
      4. Ensures %APPDATA%\aiball and the log dir exist.
      5. Writes a daemon-launcher.cmd in the install dir (handles log
         redirection — Scheduled Tasks don't capture stdout natively).
      6. Writes .cmd shims in %LOCALAPPDATA%\Microsoft\WindowsApps for
         aiball, aiball-mcp, claude-loop (on PATH by default).
      7. Registers a per-user Scheduled Task `aiball-daemon` (starts at
         logon, auto-restart on failure).
      8. Sanity check: tries to load better-sqlite3 and warns clearly if
         the native binding is missing for the current Node version.
      9. With --AuthInit: starts the task, waits for /api/health, runs
         `aiball auth init` and prints the setup URL.

.PARAMETER Symlink
    Dev install: symlink %LOCALAPPDATA%\Programs\aiball to this checkout
    instead of copying. Requires Developer Mode (Settings → Update &
    Security → For Developers) OR running as Administrator.

.PARAMETER NoAuthInit
    Skip the auto-setup-token step. By default (when humans aren't yet
    configured), the installer mints an install token, prints + writes
    the setup URL, and auto-opens it in your browser so you land
    directly on the setup form. Pass -NoAuthInit for headless installs
    where you'll do the bootstrap manually later (`aiball auth init`).

.PARAMETER AuthInit
    Deprecated alias kept for backwards compat — auth init is now the
    default. The flag is silently honored, no-op.

.PARAMETER Uninstall
    Remove shims, scheduled task, and the install dir. Leaves the data
    dir (%APPDATA%\aiball) untouched — pass --PurgeData to wipe it too.

.PARAMETER PurgeData
    With --Uninstall, also delete %APPDATA%\aiball (DB + uploads). Asks
    for confirmation unless --Yes is passed.

.PARAMETER Port
    Daemon TCP port. Default 7777.

.PARAMETER Host
    Daemon bind host. Default 127.0.0.1.

.PARAMETER Service
    Install the daemon as a Windows Service (via NSSM) instead of a
    Scheduled Task. **Requires admin elevation** — even per-user services
    need admin to register with the SCM. Default account is the current
    user; prompts for your Windows password (stored encrypted in LSA, not
    on disk). Heads up: if you change your Windows password later, the
    service stops working until you re-run install.ps1 -Service. NSSM is
    a prereq: `winget install NSSM.NSSM`.

.PARAMETER System
    Implies -Service. Runs the daemon as LocalSystem instead of your
    user account — no password needed, survives Windows password
    changes, runs at boot before login. Requires admin elevation. Uses
    %PROGRAMDATA%\aiball as the data dir (LocalSystem has no usable
    home dir).

.PARAMETER Minimal
    Light in-place install: daemon runs from this checkout directly,
    no copy to %LOCALAPPDATA%\Programs\aiball. CLI shims, tray
    shortcuts, Scheduled Task, sanity check, auth-init — all still
    happen, just pointing at the source repo. Trade-off: moving or
    deleting the source repo breaks the daemon AND the shims/tray.
    Suits a dev workflow where the repo IS the install. Incompatible
    with -Service / -System / -Symlink (-Minimal is already in-place).

.PARAMETER NoTray
    Skip the tray shortcut creation (Desktop / Start Menu / Startup
    folder). Default: shortcuts ARE created and the tray auto-launches
    at logon, following the convention of Slack / Discord / Spotify.

.PARAMETER NoClaudeLoop
    Skip installing the claude-loop wrapper's runtime deps (psmux via
    winget + Git Bash's bash.exe on PATH). The claude-loop.cmd shim is
    still installed, but `claude-loop start` will error out until you
    install psmux + ensure bash is on PATH manually. Useful if you only
    want the daemon + tray and never plan to use the autonomous loop.

.PARAMETER Yes
    Skip interactive confirmations (--PurgeData prompt).

.EXAMPLE
    PS> .\install.ps1
    Fresh user install (copy-mode, Scheduled Task at logon).

.EXAMPLE
    PS> .\install.ps1 -Minimal -AuthInit
    Light in-place install — daemon runs from this checkout. Creates
    tray shortcuts + starts the daemon + mints setup URL. No copy,
    no PATH shims. Perfect for dev workflow.

.EXAMPLE
    PS> .\install.ps1 -Symlink -AuthInit
    Dev install + start daemon + mint setup URL.

.EXAMPLE
    PS> .\install.ps1 -Service    # run from elevated PowerShell
    Install as Windows Service running as current user (NSSM, prompts
    for password). Removes any pre-existing scheduled task.

.EXAMPLE
    PS> .\install.ps1 -System    # run from elevated PowerShell
    Install as Windows Service running as LocalSystem. No password,
    boots before login, data dir under %PROGRAMDATA%\aiball.

.EXAMPLE
    PS> .\install.ps1 -Uninstall
    Remove install + scheduled task / service; keep data.
#>

[CmdletBinding()]
param(
    [switch] $Symlink,
    [switch] $AuthInit,        # back-compat no-op (default behavior now)
    [switch] $NoAuthInit,
    [switch] $Uninstall,
    [switch] $PurgeData,
    [switch] $Service,
    [switch] $System,
    [switch] $Minimal,
    [switch] $NoTray,
    [switch] $NoClaudeLoop,
    [switch] $Yes,
    [int]    $Port = 7777,
    [string] $BindHost = '127.0.0.1'
)

# -System implies -Service.
if ($System) { $Service = $true }

# -Minimal is an in-place install: daemon registered as a Scheduled
# Task but pointing at $SrcDir directly (no copy, no CLI shims, no
# PATH pollution). The tray shortcuts work because the daemon actually
# runs. Trade-off: if you move/delete the source repo, the daemon
# breaks. Suits a dev workflow where the repo IS the install.
if ($Minimal) {
    $bad = @()
    if ($Service)  { $bad += '-Service (use full install for NSSM)' }
    if ($System)   { $bad += '-System (use full install for LocalSystem)' }
    if ($Symlink)  { $bad += '-Symlink (-Minimal is already in-place)' }
    if ($bad) {
        Write-Host "[aiball] -Minimal is incompatible with: $($bad -join ', ')" -ForegroundColor Red
        exit 1
    }
}

$ErrorActionPreference = 'Stop'

# --- paths ------------------------------------------------------------------

$SrcDir    = $PSScriptRoot
$PrefixLib = Join-Path $env:LOCALAPPDATA 'Programs\aiball'
$PrefixBin = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'   # on PATH by default
# -System runs as LocalSystem which has no usable home dir, so data
# goes under %PROGRAMDATA%. Per-user installs use the same Linux-style
# path the daemon defaults to (homedir()/.local/share/aiball) so the
# shims, daemon, and CLI all agree without any AIBALL_HOME juggling.
$DataDir   = if ($System) { Join-Path $env:PROGRAMDATA 'aiball' } `
                     else { Join-Path $env:USERPROFILE '.local\share\aiball' }
$LogDir    = if ($System) { Join-Path $env:PROGRAMDATA 'aiball\logs' } `
                     else { Join-Path $env:LOCALAPPDATA 'aiball' }
$LogFile   = Join-Path $LogDir           'daemon.log'
$TaskName  = 'aiball-daemon'   # scheduled task name (and service name — separate namespaces in Windows)
$SvcName   = 'aiball-daemon'
$Shims     = @('aiball', 'aiball-mcp', 'claude-loop')

# Tray shortcut destinations (all per-user; -System install still puts
# shortcuts in the installing user's profile, not LocalSystem's).
$DesktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop'))   'aiball.lnk'
$StartLnk   = Join-Path ([Environment]::GetFolderPath('Programs'))  'aiball.lnk'
$StartupLnk = Join-Path ([Environment]::GetFolderPath('Startup'))   'aiball-tray.lnk'
# $AppDir = where the daemon source actually lives at runtime. Full
# install copies the source to $PrefixLib; -Minimal uses $SrcDir
# directly (no copy). Drives daemon-launcher.cmd's LIB var, the
# scheduled task working dir, npm install location, sanity check
# Push-Location, and the shortcut targets.
$AppDir     = if ($Minimal) { $SrcDir } else { $PrefixLib }
$AiballIco  = Join-Path $AppDir 'assets\aiball.ico'
$TrayCmd    = Join-Path $AppDir 'bin\aiball-tray.cmd'

# --- helpers ----------------------------------------------------------------

function Log($msg)  { Write-Host "[aiball] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[aiball] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[aiball] $msg" -ForegroundColor Red; exit 1 }

function Require-Cmd($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Die "missing prerequisite: $name. Install via winget (see docs\WIN-INSTALL.md)."
    }
}

function Test-DeveloperMode {
    # AllowDevelopmentWithoutDevLicense = 1 means Developer Mode is on.
    try {
        $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock'
        $val = Get-ItemProperty -Path $key -Name 'AllowDevelopmentWithoutDevLicense' -ErrorAction Stop
        return ($val.AllowDevelopmentWithoutDevLicense -eq 1)
    } catch { return $false }
}

function Test-IsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-TrayShortcuts {
    # Create the three tray .lnk shortcuts (Desktop / Start Menu /
    # Startup folder) pointing at $TrayCmd with $AiballIco as the icon.
    # Used by both the full install path and -Minimal.
    if (-not (Test-Path $TrayCmd)) {
        Warn "tray launcher not found at $TrayCmd — skipping shortcut creation"
        return
    }
    $icoArg = if (Test-Path $AiballIco) { $AiballIco } else { $TrayCmd }
    foreach ($parent in @((Split-Path $StartLnk -Parent), (Split-Path $StartupLnk -Parent))) {
        if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    }
    New-AiballShortcut $DesktopLnk $TrayCmd $icoArg "aiball — open the local UI"
    Log "wrote desktop shortcut: $DesktopLnk"
    New-AiballShortcut $StartLnk   $TrayCmd $icoArg "aiball — open the local UI"
    Log "wrote start menu shortcut: $StartLnk"
    New-AiballShortcut $StartupLnk $TrayCmd $icoArg "aiball tray (autostart at logon)"
    Log "wrote startup shortcut (autolaunch tray at logon): $StartupLnk"
}

function New-AiballShortcut($lnkPath, $target, $iconPath, $description) {
    # .lnk creation via WScript.Shell COM. The shortcut's IconLocation
    # is what shows the Death Star — .cmd files don't carry icons
    # themselves, the .lnk is where branding lives.
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($lnkPath)
        try {
            $shortcut.TargetPath = $target
            $shortcut.WorkingDirectory = Split-Path $target -Parent
            $shortcut.IconLocation = "$iconPath,0"
            $shortcut.Description = $description
            $shortcut.WindowStyle = 7   # 7 = minimized — no console flash on launch
            $shortcut.Save()
        } finally {
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shortcut) | Out-Null
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
    }
}

function Test-ServiceExists($name) {
    return [bool] (Get-Service -Name $name -ErrorAction SilentlyContinue)
}

function Test-TaskExists($name) {
    return [bool] (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)
}

function Remove-AiballTask {
    if (Test-TaskExists $TaskName) {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Log "removed scheduled task: $TaskName"
    }
}

function Stop-AiballOnPort($port) {
    # Stop-ScheduledTask sends a terminate but the daemon's node.exe
    # process can take a moment to release file handles (daemon.log
    # specifically), which then breaks Remove-Item on $LogDir. Kill
    # whatever still holds the daemon port — defensive cleanup before
    # touching files.
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            try {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
                Log "killed lingering daemon process (pid $($c.OwningProcess)) on port $port"
            } catch { }
        }
        if ($conns) { Start-Sleep -Milliseconds 500 }   # let the OS release the handles
    } catch { }
}

function Remove-AiballService {
    if (Test-ServiceExists $SvcName) {
        try { & nssm stop $SvcName confirm 2>&1 | Out-Null } catch { }
        & nssm remove $SvcName confirm 2>&1 | Out-Null
        Log "removed service: $SvcName"
    }
}

function Update-PathFromRegistry {
    # Pull the latest Machine + User PATH from the registry into the
    # current process. Useful when a tool (NSSM, node, git) was just
    # installed in a parent shell — child processes don't auto-refresh
    # PATH from the registry on startup.
    $machine = [Environment]::GetEnvironmentVariable('PATH','Machine')
    $user    = [Environment]::GetEnvironmentVariable('PATH','User')
    if ($machine -and $user) { $env:PATH = "$machine;$user" }
    elseif ($machine)        { $env:PATH = $machine }
    elseif ($user)           { $env:PATH = $user }
}

function Read-SecurePasswordPlain($prompt) {
    # SecureString -> plain text held briefly to pass to nssm. The plain
    # value is never persisted to disk; NSSM stashes it encrypted in LSA
    # Secrets after we hand it off.
    $sec = Read-Host $prompt -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try {
        return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

# --- uninstall path ---------------------------------------------------------

if ($Uninstall) {
    Log "removing daemon registration (scheduled task and/or service)"
    Remove-AiballTask
    if (Get-Command nssm -ErrorAction SilentlyContinue) {
        Remove-AiballService
    } elseif (Test-ServiceExists $SvcName) {
        Warn "service $SvcName exists but nssm is not in PATH — install NSSM and re-run -Uninstall, or remove manually via 'sc.exe delete $SvcName' (admin)"
    }
    # After stopping the task/service, the daemon process may still be
    # holding the log file. Kill anything left on the configured port
    # so the LogDir Remove-Item below doesn't trip over locked handles.
    Stop-AiballOnPort $Port

    foreach ($name in $Shims) {
        $path = Join-Path $PrefixBin "$name.cmd"
        if (Test-Path $path) {
            Remove-Item $path -Force
            Log "removed shim: $path"
        }
    }

    foreach ($lnk in @($DesktopLnk, $StartLnk, $StartupLnk)) {
        if (Test-Path $lnk) {
            Remove-Item $lnk -Force
            Log "removed shortcut: $lnk"
        }
    }

    if (Test-Path $PrefixLib) {
        # Symlink vs real dir: Remove-Item -Recurse follows symlinks on
        # older PowerShell. Detect and unlink first to be safe.
        $item = Get-Item $PrefixLib -Force
        if ($item.LinkType -eq 'SymbolicLink') {
            $item.Delete()
            Log "removed install symlink: $PrefixLib (source dir untouched: $($item.Target))"
        } else {
            Remove-Item -Recurse -Force $PrefixLib
            Log "removed install dir: $PrefixLib"
        }
    }

    # Logs may live in either location depending on whether the install
    # was -System (PROGRAMDATA) or per-user (LOCALAPPDATA). Clean both
    # so uninstall is correct regardless of which flag the user passes.
    foreach ($d in @((Join-Path $env:LOCALAPPDATA 'aiball'),
                     (Join-Path $env:PROGRAMDATA  'aiball\logs'))) {
        if (Test-Path $d) {
            Remove-Item -Recurse -Force $d
            Log "removed log dir: $d"
        }
    }

    # Same story for data dirs: check both. PurgeData applies to both.
    $dataCandidates = @((Join-Path $env:APPDATA     'aiball'),
                        (Join-Path $env:PROGRAMDATA 'aiball')) | Where-Object { Test-Path $_ }
    if ($PurgeData) {
        foreach ($d in $dataCandidates) {
            if (-not $Yes) {
                $resp = Read-Host "delete data dir $d (DB + uploads)? [y/N]"
                if ($resp -notmatch '^[yY]') { Warn "kept $d"; continue }
            }
            Remove-Item -Recurse -Force $d
            Log "removed data dir: $d"
        }
    } else {
        foreach ($d in $dataCandidates) { Warn "data dir kept at $d (pass --PurgeData to remove)" }
    }
    exit 0
}

# --- install path -----------------------------------------------------------

# Refresh PATH from the registry before prereq checks — handles the
# common case of running install.ps1 right after `winget install ...`
# in the same shell session (the new PATH otherwise only takes effect
# in fresh shells).
Update-PathFromRegistry

Require-Cmd node
Require-Cmd npm
Require-Cmd git

if ($Service) {
    Require-Cmd nssm   # `winget install NSSM.NSSM` if missing
    # Creating ANY Windows service requires admin (NSSM can't bypass
    # the SCM permission requirement). The -System flag changes the
    # account the service runs as, but the install itself always
    # needs elevation.
    if (-not (Test-IsAdmin)) {
        Die "-Service requires running install.ps1 from an elevated PowerShell (right-click -> Run as administrator). Even per-user services need admin to install."
    }
    Log "service mode: $(if ($System) { 'LocalSystem (global)' } else { 'current user (' + $env:USERNAME + ')' })"
}

# --- claude-loop runtime deps: psmux + bash on PATH ------------------------
# We ship the claude-loop.cmd shim in every install path, so ensure its
# deps are reachable. psmux ships a tmux alias, so claude-loop's
# MUX_CMD=tmux (default) finds it. Git Bash provides bash for the inner
# `bash -lc 'source env; exec claude'` command. -NoClaudeLoop opts out.

if (-not $NoClaudeLoop) {
    if (-not (Get-Command tmux  -ErrorAction SilentlyContinue) -and `
        -not (Get-Command psmux -ErrorAction SilentlyContinue)) {
        Log "psmux not detected — installing via winget (claude-loop dep)"
        # Name-based search (not --id) so we don't have to track the
        # exact Publisher.Name slug — winget matches on name/moniker too.
        try {
            & winget install psmux --silent `
                --accept-source-agreements --accept-package-agreements 2>&1 | Out-Host
        } catch {
            Warn "winget install psmux failed: $($_.Exception.Message)"
        }
        Update-PathFromRegistry
        if (-not (Get-Command tmux  -ErrorAction SilentlyContinue) -and `
            -not (Get-Command psmux -ErrorAction SilentlyContinue)) {
            Warn "psmux still not on PATH — claude-loop start won't work."
            Warn "  Try: winget search psmux  (find the right package id)"
            Warn "  Then: winget install <id>"
        } else {
            Log "psmux on PATH OK"
        }
    } else {
        Log "psmux/tmux already on PATH"
    }

    # Git Bash: winget installs git.exe via C:\Program Files\Git\cmd\ but
    # NOT bash.exe (which lives in C:\Program Files\Git\bin\). claude-loop
    # spawns `bash -lc 'source env; exec claude'` so bash must be findable.
    if (-not (Get-Command bash -ErrorAction SilentlyContinue)) {
        $gitBin = 'C:\Program Files\Git\bin'
        if (Test-Path (Join-Path $gitBin 'bash.exe')) {
            $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
            if ($userPath -notlike "*$gitBin*") {
                [Environment]::SetEnvironmentVariable('PATH', "$gitBin;$userPath", 'User')
                Log "added $gitBin to user PATH (claude-loop needs bash)"
            } else {
                Log "Git Bash already in user PATH (will resolve in fresh shells)"
            }
            Update-PathFromRegistry
        } else {
            Warn "bash.exe not found — claude-loop start needs Git Bash."
            Warn "  Install Git for Windows (winget install Git.Git) and re-run."
        }
    } else {
        Log "bash already on PATH"
    }
}

# Node version: hard fail <20 (matches package.json engines). better-
# sqlite3 v12 ships prebuilt bindings for Node 22/24 (and forward as
# they release prebuilds for new majors). The sanity check below
# catches the rare case where a brand-new Node major lands without
# prebuilds yet.
$nodeVerRaw = (node --version) -replace '^v',''
$nodeMajor  = [int]($nodeVerRaw.Split('.')[0])
if ($nodeMajor -lt 20) { Die "node >=20 required, found v$nodeVerRaw" }

# --- install dir provisioning ----------------------------------------------
# Reentrant: re-running with no flag preserves the existing layout.
# Switching modes requires --Uninstall first (avoids silently flipping a
# dev symlink into a prod copy or vice versa).
# Skipped entirely under -Minimal (the daemon runs from $SrcDir in place).

if (-not $Minimal) {
    if (Test-Path $PrefixLib) {
        $existing = Get-Item $PrefixLib -Force
        $existingIsLink = ($existing.LinkType -eq 'SymbolicLink')
        if ($existingIsLink -and -not $Symlink) {
            Log "existing install at $PrefixLib is a symlink — keeping dev layout"
            Log "  (re-run with --Uninstall first to switch to a prod copy)"
            $Symlink = $true   # honor the existing layout for the rest of this run
        } elseif (-not $existingIsLink -and $Symlink) {
            Die "existing install at $PrefixLib is a real directory. --Uninstall first to switch to --Symlink."
        }
    }

    if ($Symlink) {
        if (-not (Test-DeveloperMode) -and -not (Test-IsAdmin)) {
            Die "--Symlink requires Developer Mode (Settings -> For Developers) or admin elevation."
        }
        if (Test-Path $PrefixLib) { Remove-Item -Force $PrefixLib }
        $parent = Split-Path $PrefixLib -Parent
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        New-Item -ItemType SymbolicLink -Path $PrefixLib -Target $SrcDir | Out-Null
        Log "symlinked $PrefixLib -> $SrcDir (dev install)"
    } else {
        Log "copying source to $PrefixLib"
        if (Test-Path $PrefixLib) { Remove-Item -Recurse -Force $PrefixLib }
        New-Item -ItemType Directory -Force -Path $PrefixLib | Out-Null
        # Mirror rsync excludes from install.sh. Robocopy is the right tool
        # (Copy-Item -Recurse is slow + chokes on long paths).
        $robocopyArgs = @(
            $SrcDir, $PrefixLib,
            '/MIR',           # mirror tree
            '/XD', 'node_modules', '.git', 'var', 'frontend\node_modules',
            '/XF', '*.log', '.env',
            '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/NP'   # quiet
        )
        & robocopy.exe @robocopyArgs | Out-Null
        # Robocopy exit codes: 0-7 are success (with caveats), 8+ are errors.
        if ($LASTEXITCODE -ge 8) { Die "robocopy failed with exit $LASTEXITCODE" }
    }
} else {
    Log "minimal install: running daemon in place from $SrcDir (no copy)"
}

# --- npm install + frontend build in the install dir ----------------------

Log "running npm install in $AppDir"
Push-Location $AppDir
try {
    # No --silent here: npm install failures (compile errors, missing
    # bindings, etc.) need to be visible. The daemon won't start
    # without the deps, so we Die on non-zero exit.
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Die "npm install failed in $AppDir (exit $LASTEXITCODE). The daemon needs the deps to run — fix the error above and re-run install.ps1."
    }
    if (-not (Test-Path (Join-Path $AppDir 'frontend\dist\index.html'))) {
        Log "building frontend bundle (~30s)"
        Push-Location (Join-Path $AppDir 'frontend')
        try {
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                Warn "frontend 'npm install' failed (exit $LASTEXITCODE) - daemon will run without the SPA (UI returns 503 from /)"
            } else {
                npm run build
                if ($LASTEXITCODE -ne 0) {
                    Warn "frontend 'npm run build' failed (exit $LASTEXITCODE) - daemon will run without the SPA (UI returns 503 from /)"
                }
            }
        } finally { Pop-Location }
    } else {
        Log "frontend bundle already present"
    }
} finally { Pop-Location }

# --- data + log dirs --------------------------------------------------------

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir  | Out-Null
Log "ensured data dir: $DataDir"
Log "ensured log dir:  $LogDir"

# --- daemon launcher (handles log redirection for Scheduled Task) ---------
# Scheduled Tasks don't capture stdout natively. The launcher .cmd cd's
# into the install dir and pipes both streams into $LogFile with a roll
# guard (truncate if > 8MB). Lives in $LogDir (next to the log file) so
# --Symlink installs don't pollute the source tree with a generated .cmd.

$launcherPath = Join-Path $LogDir 'daemon-launcher.cmd'
# -System runs as LocalSystem which has no usable home dir, so the
# daemon's default `homedir()/.local/share/aiball` would resolve under
# C:\Windows\system32\config\systemprofile — far from where the
# installer put the data. Pin AIBALL_HOME explicitly in that mode so
# the daemon writes/reads from %PROGRAMDATA%\aiball. Also pin
# AIBALL_SOCK="" under -System so the daemon doesn't try to create a
# UDS at %PROGRAMDATA%\aiball\sock that per-user shims (whose default
# AIBALL_HOME is %USERPROFILE%\.local\share\aiball) wouldn't see —
# -System users fall back to TCP+token by design.
$envOverrides = if ($System) {
    "set `"AIBALL_HOME=$DataDir`"`r`nset `"AIBALL_SOCK=`""
} else { '' }
$launcherBody = @"
@echo off
setlocal EnableExtensions

REM Auto-generated by install.ps1 — runs the aiball daemon for the
REM scheduled task / service. Redirects stdout+stderr into the log
REM file. Rolls the log if it exceeds 8MB.

set "LOG=$LogFile"
set "LIB=$AppDir"

cd /d "%LIB%"

if exist "%LOG%" (
    for %%I in ("%LOG%") do if %%~zI GTR 8388608 (
        if exist "%LOG%.1" del "%LOG%.1"
        move /y "%LOG%" "%LOG%.1" >nul
    )
)

set "AIBALL_PORT=$Port"
set "AIBALL_HOST=$BindHost"
$envOverrides

echo [%date% %time%] launching aiball daemon (port $Port) >> "%LOG%"
npx.cmd --no-install tsx src\daemon.ts >> "%LOG%" 2>&1
"@
[System.IO.File]::WriteAllText($launcherPath, ($launcherBody -replace "`r?`n","`r`n"))
Log "wrote daemon launcher: $launcherPath"

# Hidden wrapper: cmd.exe /c .cmd shows a console window when launched
# by the Scheduled Task — ugly. wscript.exe + a tiny .vbs that does
# Shell.Run "cmd /c ...", 0 (= SW_HIDE) runs the .cmd with no window.
# Classic Windows pattern for headless background scripts.
$vbsPath = Join-Path $LogDir 'daemon-launcher.vbs'
$vbsBody = @"
' Auto-generated by install.ps1 — launches daemon-launcher.cmd with
' no visible console window (the third arg "0" = SW_HIDE).
CreateObject("WScript.Shell").Run "cmd /c """ & "$launcherPath" & """", 0, False
"@
[System.IO.File]::WriteAllText($vbsPath, ($vbsBody -replace "`r?`n","`r`n"))
Log "wrote hidden launcher wrapper: $vbsPath"

# --- .cmd shims in $PrefixBin ---------------------------------------------
# Tiny wrappers that exec the real .cmd in $AppDir\bin. No symlink
# required — works without admin / Developer Mode. Same shim set under
# -Minimal (points at $SrcDir\bin\*.cmd in that mode); without these
# the user would have to type the full path to call aiball / claude-loop.

if (-not (Test-Path $PrefixBin)) { New-Item -ItemType Directory -Force -Path $PrefixBin | Out-Null }
foreach ($name in $Shims) {
    $target = Join-Path $AppDir "bin\$name.cmd"
    if (-not (Test-Path $target)) {
        Warn "expected shim source missing: $target — skipping $name.cmd"
        continue
    }
    $shimPath = Join-Path $PrefixBin "$name.cmd"
    $shimBody = @"
@echo off
"$target" %*
exit /b %errorlevel%
"@
    [System.IO.File]::WriteAllText($shimPath, ($shimBody -replace "`r?`n","`r`n"))
    Log "wrote shim: $shimPath -> $target"
}

# --- tray shortcuts (Desktop / Start Menu / Startup folder) ----------------
# Three shortcuts, all pointing at $TrayCmd with the Death Star icon.
# Same .lnk regardless of daemon mode (Task vs Service vs Minimal) —
# consistent visible UX. `-NoTray` opts out entirely. Per-user only
# (even with -System the shortcuts go in the installing user's profile).

if (-not $NoTray) { Write-TrayShortcuts }

# --- Scheduled Task OR Service (mutually exclusive) ------------------------
# Only one runs the daemon. The opposite mode's registration is cleared
# so we never have two daemons fighting over port $Port.

if ($Service) {
    if (Test-TaskExists $TaskName) {
        Warn "switching from scheduled task to service — removing existing task"
        Remove-AiballTask
    }
    # Re-create cleanly (NSSM install fails if the service exists).
    Remove-AiballService

    Log "installing Windows Service: $SvcName (via nssm)"
    & nssm install $SvcName 'cmd.exe' '/c' $launcherPath | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "nssm install failed (exit $LASTEXITCODE)" }
    & nssm set $SvcName AppDirectory $PrefixLib       | Out-Null
    & nssm set $SvcName Description "aiball daemon (#B.178). Logs to $LogFile" | Out-Null
    & nssm set $SvcName Start SERVICE_AUTO_START      | Out-Null
    # Restart on any exit with 60s delay (mirrors the scheduled task
    # restart-x5-every-1min policy in spirit; NSSM is open-ended).
    & nssm set $SvcName AppExit Default Restart       | Out-Null
    & nssm set $SvcName AppRestartDelay 60000         | Out-Null

    if ($System) {
        & nssm set $SvcName ObjectName LocalSystem    | Out-Null
        Log "service runs as LocalSystem (admin, global)"
    } else {
        Log "service runs as $env:USERDOMAIN\$env:USERNAME — Windows needs your password to log in this account non-interactively at boot"
        Log "the password is stored encrypted in LSA Secrets (never plaintext on disk), but if you change your Windows password later you'll need to re-run install.ps1 -Service to re-set it"
        $plainPass = Read-SecurePasswordPlain "Windows password for $env:USERNAME"
        try {
            & nssm set $SvcName ObjectName "$env:USERDOMAIN\$env:USERNAME" $plainPass | Out-Null
            if ($LASTEXITCODE -ne 0) { Die "nssm set ObjectName failed (exit $LASTEXITCODE) — check the password" }
        } finally {
            $plainPass = $null   # best-effort clear from PS memory
            [System.GC]::Collect()
        }
    }
    Log "service installed (SERVICE_AUTO_START, restart on any exit + 60s delay)"
} else {
    if (Test-ServiceExists $SvcName) {
        Warn "switching from service to scheduled task — removing existing service"
        if (Get-Command nssm -ErrorAction SilentlyContinue) {
            Remove-AiballService
        } else {
            Die "service $SvcName exists but nssm is not in PATH — install NSSM and re-run, or manually remove via 'sc.exe delete $SvcName' (admin)"
        }
    }

    Log "registering scheduled task: $TaskName (daemon source: $AppDir)"
    # Use wscript.exe + the .vbs wrapper instead of cmd.exe directly so
    # no console window flashes when the task fires interactively at
    # logon. cmd.exe is still what ultimately runs the launcher — vbs
    # just hides the host window.
    $action   = New-ScheduledTaskAction `
        -Execute 'wscript.exe' `
        -Argument "`"$vbsPath`"" `
        -WorkingDirectory $AppDir
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -RestartCount 5 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0)   # 0 = unlimited
    $principal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType Interactive `
        -RunLevel Limited

    # Re-register if it already exists (Register-ScheduledTask -Force replaces).
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "aiball daemon (#B.178). Logs to $LogFile." `
        -Force | Out-Null
    Log "scheduled task registered (AtLogOn, restart x5 every 1min)"
}

# --- sanity check: better-sqlite3 native binding --------------------------
# The daemon will fail to start if the native binding isn't built for
# the current Node version. Probe with `new Database(':memory:')` rather
# than just `require()` — the JS module loads fine without the .node
# binding; the lookup only fires when a Database is constructed (which
# is what daemon.ts -> db.ts -> getDb() does at startup).

Log "checking better-sqlite3 native binding"
Push-Location $AppDir
try {
    $probe = node -e "try { const D=require('better-sqlite3'); new D(':memory:'); console.log('OK') } catch(e) { console.error(e.message); process.exit(1) }" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Warn "better-sqlite3 native binding failed to load:"
        Warn "  $probe"
        Warn "The daemon will not start until this is fixed. Options:"
        Warn "  - bump better-sqlite3 in package.json to a version with"
        Warn "    prebuilts for your Node major (check npm)"
        Warn "  - install VS Build Tools + rebuild in $AppDir :"
        Warn "      npm rebuild better-sqlite3 --build-from-source"
        Warn "  - pin Node to current LTS (winget install OpenJS.NodeJS.LTS)"
        if ($Service) {
            Warn "Stopping the service and switching it to Manual start so it"
            Warn "doesn't restart-loop. Once fixed, re-enable with:"
            Warn "  Set-Service -Name $SvcName -StartupType Automatic"
            Warn "  Start-Service $SvcName"
            try { & nssm stop $SvcName confirm 2>&1 | Out-Null } catch { }
            Set-Service -Name $SvcName -StartupType Manual -ErrorAction SilentlyContinue
        } else {
            Warn "Disabling the scheduled task so it doesn't restart-loop at logon."
            Warn "Once fixed, re-enable with: Enable-ScheduledTask -TaskName $TaskName"
            Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        }
        $sqliteOk = $false
    } else {
        Log "better-sqlite3 native binding loads OK"
        $sqliteOk = $true
    }
} finally { Pop-Location }

# --- post-install: auth-init ---------------------------------------------

# Default behavior since user feedback: always run auth init on a fresh
# install (skipped only with -NoAuthInit, or if the sanity check
# disabled the daemon). Writes the setup URL to $LogDir\setup-url.txt
# so the tray can pick it up later, and auto-opens it in the browser
# so the user lands directly on the setup form.
$setupUrlFile = Join-Path $LogDir 'setup-url.txt'
if (-not $NoAuthInit) {
    if (-not $sqliteOk) {
        Warn "skipping auth init because the daemon can't start (better-sqlite3)"
    } else {
        if ($Service) {
            Log "starting service $SvcName"
            Start-Service -Name $SvcName
        } else {
            Log "starting daemon via $TaskName"
            Start-ScheduledTask -TaskName $TaskName
        }
        $healthUrl  = "http://${BindHost}:${Port}/api/health"
        $statusUrl  = "http://${BindHost}:${Port}/api/auth/status"
        Log "waiting for daemon health at $healthUrl (up to 15s)"
        $up = $false
        for ($i = 0; $i -lt 15; $i++) {
            Start-Sleep -Seconds 1
            try {
                Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1 | Out-Null
                $up = $true; break
            } catch { }
        }
        if ($up) {
            # Only mint a token if not already set up. /api/auth/status
            # is public and returns { ready, install_available, me }.
            $alreadyReady = $false
            try {
                $st = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2
                $alreadyReady = [bool] $st.ready
            } catch { }
            if ($alreadyReady) {
                Log "aiball is already set up (humans configured) — skipping auth init"
                if (Test-Path $setupUrlFile) { Remove-Item $setupUrlFile -Force -ErrorAction SilentlyContinue }
            } else {
                Log "daemon up. Running 'aiball auth init'"
                # Call the shim in $PrefixBin (added to PATH automatically
                # on Win10+). Both -Minimal and full install put it there.
                $aiballCmd = Join-Path $PrefixBin 'aiball.cmd'
                $output = & $aiballCmd auth init --host $BindHost --port $Port 2>&1
                $output | ForEach-Object { Write-Host $_ }   # mirror to console
                # Parse the setup URL out of the output.
                $urlMatch = $output | Select-String -Pattern 'http[s]?://[^\s]+' -AllMatches | Select-Object -First 1
                if ($urlMatch) {
                    $setupUrl = $urlMatch.Matches[0].Value
                    [System.IO.File]::WriteAllText($setupUrlFile, $setupUrl)
                    Log "setup URL persisted to: $setupUrlFile"
                    try {
                        Start-Process $setupUrl
                        Log "opened setup URL in your default browser"
                    } catch {
                        Warn "failed to open browser automatically — copy/paste the URL above"
                    }
                }
            }
        } else {
            Warn "daemon did not respond at $healthUrl after 15s"
            Warn "check the log: $LogFile"
        }
    }
}

# --- launch the tray now ---------------------------------------------------
# The Startup-folder shortcut fires at next logon, but the user just
# installed — they expect to see the icon NOW. Launch it explicitly so
# it appears in the notification area (or overflow) right away.
if (-not $NoTray -and (Test-Path $TrayCmd)) {
    try {
        Start-Process -FilePath $TrayCmd -WindowStyle Hidden
        Log "launched tray (icon should appear in the notification area)"
    } catch {
        Warn "failed to launch tray now: $($_.Exception.Message)"
        Warn "  it will start automatically at next logon (Startup folder shortcut)"
    }
}

# --- final message --------------------------------------------------------

Write-Host ''
Write-Host '----------------------------------------------------------------------'
if ($sqliteOk) {
    Write-Host '[aiball] install complete.' -ForegroundColor Green
} else {
    Write-Host '[aiball] install complete (degraded — daemon disabled).' -ForegroundColor Yellow
}
Write-Host ''
if ($Minimal) {
    Write-Host "  mode:        minimal (in-place — daemon runs from $SrcDir)"
} else {
    Write-Host "  install dir: $PrefixLib$(if ($Symlink) { '  (symlink -> ' + $SrcDir + ')' })"
}
Write-Host "  data dir:    $DataDir"
Write-Host "  log file:    $LogFile"
if ($Service) {
    $acct = if ($System) { 'LocalSystem' } else { "$env:USERDOMAIN\$env:USERNAME" }
    Write-Host "  daemon:      Get-Service -Name $SvcName   (runs as $acct)"
    Write-Host "  start:       Start-Service -Name $SvcName"
    Write-Host "  stop:        Stop-Service -Name $SvcName"
} else {
    Write-Host "  daemon:      Get-ScheduledTask -TaskName $TaskName"
    Write-Host "  start:       Start-ScheduledTask -TaskName $TaskName"
    Write-Host "  stop:        Stop-ScheduledTask -TaskName $TaskName"
}
Write-Host "  open:        http://${BindHost}:${Port}"
Write-Host "  cli:         aiball / aiball-mcp / claude-loop  (shims in $PrefixBin -> $AppDir\bin)"
if (-not $sqliteOk) {
    Write-Host ''
    Write-Host '  Fix better-sqlite3 first (see warnings above), then:'
    if ($Service) {
        Write-Host "         Set-Service -Name $SvcName -StartupType Automatic"
        Write-Host "         Start-Service -Name $SvcName"
    } else {
        Write-Host "         Enable-ScheduledTask -TaskName $TaskName"
        Write-Host "         Start-ScheduledTask  -TaskName $TaskName"
    }
} elseif ($NoAuthInit) {
    Write-Host ''
    Write-Host '  Next (-NoAuthInit was passed): start the daemon, then mint a setup token:'
    if ($Service) {
        Write-Host "         Start-Service -Name $SvcName"
    } else {
        Write-Host "         Start-ScheduledTask -TaskName $TaskName"
    }
    Write-Host "         aiball auth init --host $BindHost --port $Port"
}
Write-Host '----------------------------------------------------------------------'

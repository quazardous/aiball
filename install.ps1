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

.PARAMETER AuthInit
    After install, start the daemon, wait for it to be reachable, mint a
    one-time install token and print the setup URL.

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

.PARAMETER Yes
    Skip interactive confirmations (--PurgeData prompt).

.EXAMPLE
    PS> .\install.ps1
    Fresh user install (copy-mode).

.EXAMPLE
    PS> .\install.ps1 -Symlink -AuthInit
    Dev install + start daemon + mint setup URL.

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
    [int]    $Port = 7777,
    [string] $BindHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

# --- paths ------------------------------------------------------------------

$SrcDir    = $PSScriptRoot
$PrefixLib = Join-Path $env:LOCALAPPDATA 'Programs\aiball'
$PrefixBin = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'   # on PATH by default
$DataDir   = Join-Path $env:APPDATA      'aiball'
$LogDir    = Join-Path $env:LOCALAPPDATA 'aiball'
$LogFile   = Join-Path $LogDir           'daemon.log'
$TaskName  = 'aiball-daemon'
$Shims     = @('aiball', 'aiball-mcp', 'claude-loop')

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

# --- uninstall path ---------------------------------------------------------

if ($Uninstall) {
    Log "stopping scheduled task $TaskName (if present)"
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | ForEach-Object {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    foreach ($name in $Shims) {
        $path = Join-Path $PrefixBin "$name.cmd"
        if (Test-Path $path) {
            Remove-Item $path -Force
            Log "removed shim: $path"
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

    if (Test-Path $LogDir) {
        # Logs go with the install — DataDir is the durable bit.
        Remove-Item -Recurse -Force $LogDir
        Log "removed log dir: $LogDir"
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

# Node version: hard fail <20 (matches package.json engines), warn >=24
# (better-sqlite3@11.x ships prebuilt bindings up to Node 22; Node 24
# requires either downgrade or `npm rebuild` with VS Build Tools).
$nodeVerRaw = (node --version) -replace '^v',''
$nodeMajor  = [int]($nodeVerRaw.Split('.')[0])
if ($nodeMajor -lt 20) { Die "node >=20 required, found v$nodeVerRaw" }
if ($nodeMajor -ge 24) {
    Warn "node v$nodeVerRaw detected — better-sqlite3 prebuilt bindings"
    Warn "may not exist for this version. If the daemon fails to start"
    Warn "with 'Could not locate the bindings file', either:"
    Warn "  - downgrade to Node 22 LTS (winget install OpenJS.NodeJS.LTS), or"
    Warn "  - install VS Build Tools and run 'npm rebuild better-sqlite3'"
    Warn "  - inside $PrefixLib"
}

# --- install dir provisioning ----------------------------------------------
# Reentrant: re-running with no flag preserves the existing layout.
# Switching modes requires --Uninstall first (avoids silently flipping a
# dev symlink into a prod copy or vice versa).

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

# --- npm install + frontend build in the install dir ----------------------

Log "running npm install in $PrefixLib"
Push-Location $PrefixLib
try {
    # No --silent here: npm install failures (compile errors, missing
    # bindings, etc.) need to be visible. The daemon won't start
    # without the deps, so we Die on non-zero exit.
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        Die "npm install failed in $PrefixLib (exit $LASTEXITCODE). The daemon needs the deps to run — fix the error above and re-run install.ps1."
    }
    if (-not (Test-Path (Join-Path $PrefixLib 'frontend\dist\index.html'))) {
        Log "building frontend bundle (~30s)"
        Push-Location (Join-Path $PrefixLib 'frontend')
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
$launcherBody = @"
@echo off
setlocal EnableExtensions

REM Auto-generated by install.ps1 — runs the aiball daemon for the
REM Scheduled Task. Redirects stdout+stderr into the log file. Roll
REM the log if it exceeds 8MB.

set "LOG=$LogFile"
set "LIB=$PrefixLib"

cd /d "%LIB%"

if exist "%LOG%" (
    for %%I in ("%LOG%") do if %%~zI GTR 8388608 (
        if exist "%LOG%.1" del "%LOG%.1"
        move /y "%LOG%" "%LOG%.1" >nul
    )
)

set "AIBALL_PORT=$Port"
set "AIBALL_HOST=$BindHost"

echo [%date% %time%] launching aiball daemon (port $Port) >> "%LOG%"
npx.cmd --no-install tsx src\daemon.ts >> "%LOG%" 2>&1
"@
[System.IO.File]::WriteAllText($launcherPath, ($launcherBody -replace "`r?`n","`r`n"))
Log "wrote daemon launcher: $launcherPath"

# --- .cmd shims in $PrefixBin ---------------------------------------------
# Tiny wrappers that exec the real .cmd in the install dir. No symlink
# required — works without admin / Developer Mode.

if (-not (Test-Path $PrefixBin)) { New-Item -ItemType Directory -Force -Path $PrefixBin | Out-Null }
foreach ($name in $Shims) {
    $target = Join-Path $PrefixLib "bin\$name.cmd"
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

# --- Scheduled Task ---------------------------------------------------------

Log "registering scheduled task: $TaskName"
$action   = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c `"$launcherPath`"" `
    -WorkingDirectory $PrefixLib
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

# --- sanity check: better-sqlite3 native binding --------------------------
# The daemon will fail to start if the native binding isn't built for
# the current Node version. Probe with `new Database(':memory:')` rather
# than just `require()` — the JS module loads fine without the .node
# binding; the lookup only fires when a Database is constructed (which
# is what daemon.ts -> db.ts -> getDb() does at startup).

Log "checking better-sqlite3 native binding"
Push-Location $PrefixLib
try {
    $probe = node -e "try { const D=require('better-sqlite3'); new D(':memory:'); console.log('OK') } catch(e) { console.error(e.message); process.exit(1) }" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Warn "better-sqlite3 native binding failed to load:"
        Warn "  $probe"
        Warn "The daemon will not start until this is fixed. Options:"
        Warn "  - downgrade Node to 22 LTS (winget install OpenJS.NodeJS.LTS)"
        Warn "  - install VS Build Tools, then in $PrefixLib :"
        Warn "      npm rebuild better-sqlite3 --build-from-source"
        Warn "Disabling the scheduled task so it doesn't restart-loop at logon."
        Warn "Once fixed, re-enable with: Enable-ScheduledTask -TaskName $TaskName"
        Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
        $sqliteOk = $false
    } else {
        Log "better-sqlite3 native binding loads OK"
        $sqliteOk = $true
    }
} finally { Pop-Location }

# --- post-install: auth-init ---------------------------------------------

if ($AuthInit) {
    if (-not $sqliteOk) {
        Warn "skipping --AuthInit because the daemon can't start (better-sqlite3)"
    } else {
        Log "starting daemon via $TaskName"
        Start-ScheduledTask -TaskName $TaskName
        $healthUrl = "http://${BindHost}:${Port}/api/health"
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
            Log "daemon up. Running 'aiball auth init'"
            $aiballCmd = Join-Path $PrefixBin 'aiball.cmd'
            & $aiballCmd auth init --host $BindHost --port $Port
        } else {
            Warn "daemon did not respond at $healthUrl after 15s"
            Warn "check the log: $LogFile"
        }
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
Write-Host "  install dir: $PrefixLib$(if ($Symlink) { '  (symlink -> ' + $SrcDir + ')' })"
Write-Host "  data dir:    $DataDir"
Write-Host "  log file:    $LogFile"
Write-Host "  daemon:      Get-ScheduledTask -TaskName $TaskName"
Write-Host "  start:       Start-ScheduledTask -TaskName $TaskName"
Write-Host "  stop:        Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  open:        http://${BindHost}:${Port}"
if (-not $sqliteOk) {
    Write-Host ''
    Write-Host '  Fix better-sqlite3 first (see warnings above), then:'
    Write-Host "         Enable-ScheduledTask -TaskName $TaskName"
    Write-Host "         Start-ScheduledTask  -TaskName $TaskName"
} elseif (-not $AuthInit) {
    Write-Host ''
    Write-Host '  Next: start the daemon, then mint a setup token:'
    Write-Host "         Start-ScheduledTask -TaskName $TaskName"
    Write-Host "         aiball auth init --host $BindHost --port $Port"
}
Write-Host '----------------------------------------------------------------------'

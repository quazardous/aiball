# aiball-tray.ps1 -- system-tray (notification area) icon for the Windows
# install. The tray IS the app (Slack/Spotify model): it OWNS the daemon.
#
#   - On launch it starts the daemon (if not already healthy) and shows the
#     icon, so "icon visible = aiball is running" -- no hidden background
#     daemon a Windows user wouldn't know about.
#   - A health timer supervises the daemon and restarts it if it dies.
#   - "Quit aiball" stops the daemon and exits -- closing the icon really
#     closes aiball.
#
# Headless/server installs that want a daemon WITHOUT a tray use
# `install.ps1 -NoTray` (daemon via the scheduled task) or `-Service`.
#
# Launched by aiball-tray.cmd (hidden PowerShell), itself started at logon by
# the `aiball-daemon` scheduled task (and from the Desktop/Start shortcuts).
#
# IMPORTANT: keep this file ASCII-only. aiball-tray.cmd runs it via Windows
# PowerShell 5.1 (`powershell.exe`), which reads a BOM-less file as the system
# codepage -- any non-ASCII char (accents, em-dash, ellipsis) gets mangled and
# can break string parsing, crashing the tray before the icon shows. Keep all
# user-facing strings English + ASCII (see CLAUDE.md i18n policy).

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Singleton: a second instance exits silently (mutex), so double-clicking a
# shortcut while the logon-launched tray is up doesn't stack icons.
$mutexName = 'Local\aiball-tray-singleton'
$createdNew = $false
$singletonMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    $singletonMutex.Dispose()
    exit 0
}

# --- resolve daemon launcher + port ----------------------------------------
# The launcher (+ hidden .vbs wrapper) is written by install.ps1 into
# %LOCALAPPDATA%\aiball. We reuse it to start the daemon so the command + env
# (port, log rolling, AIBALL_HOME) live in ONE place.
$aiballLocal = Join-Path $env:LOCALAPPDATA 'aiball'
$daemonVbs   = Join-Path $aiballLocal 'daemon-launcher.vbs'
$daemonCmd   = Join-Path $aiballLocal 'daemon-launcher.cmd'

# Port: prefer the value baked into the launcher (custom -Port installs),
# else AIBALL_PORT env, else the 7777 default.
function Resolve-Port {
    if (Test-Path $daemonCmd) {
        $m = Select-String -Path $daemonCmd -Pattern 'AIBALL_PORT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    if ($env:AIBALL_PORT) { return $env:AIBALL_PORT }
    return '7777'
}
$port = Resolve-Port
$url  = "http://127.0.0.1:$port"

# --- daemon lifecycle -------------------------------------------------------
function Get-NodeInfo {
    # Local liveness + "is this a proxy" flag + (proxy mode) the REMOTE's health.
    # /api/node is served LOCALLY even in proxy mode (where /api/health relays to
    # the remote); fall back to /api/health for older daemons (proxy unknown).
    try {
        $n = Invoke-RestMethod -Uri "$url/api/node" -TimeoutSec 1 -ErrorAction Stop
        $info = @{ up = [bool]$n.ok; proxy = [bool]$n.proxy; remoteUp = $false }
        if ($info.proxy) {
            # In proxy mode /api/health relays to the remote -> tests the remote.
            try {
                $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2 -ErrorAction Stop
                $info.remoteUp = [bool]$h.ok
            } catch { }
        }
        return $info
    } catch { }
    try {
        $h = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1 -ErrorAction Stop
        return @{ up = [bool]$h.ok; proxy = $false; remoteUp = $false }
    } catch { return @{ up = $false; proxy = $false; remoteUp = $false } }
}
function Test-DaemonUp { return (Get-NodeInfo).up }

# Tray icon variants. The proxy overlay icons are PRE-GENERATED multi-resolution
# .ico files (assets/aiball-proxy-{up,down}.ico, built by
# assets/gen-proxy-icons.ps1) -- an upward "uplink" arrow over the base icon,
# green when the remote is healthy, red when it's down. They are FILES (loaded
# once, like the base) so the notification area picks a NATIVE frame for its
# size. Runtime composition was dropped: it produced a single 32x32 frame the
# tray downscaled into "snow". Set-TrayIcon just swaps among the three.
function Get-IconFile($path, $fallback) {
    if (Test-Path $path) {
        try { return (New-Object System.Drawing.Icon $path) } catch { }
    }
    return $fallback
}

function Set-TrayIcon([bool]$proxy, [bool]$remoteUp) {
    if (-not $proxy) {
        $ni.Icon = $script:baseIcon
    } elseif ($remoteUp) {
        $ni.Icon = $script:proxyUpIcon
    } else {
        $ni.Icon = $script:proxyDownIcon
    }
}

function Start-Daemon {
    # Idempotent: never spawn a second daemon if one already answers.
    if (Test-DaemonUp) { return }
    if (Test-Path $daemonVbs) {
        # wscript + .vbs = no console flash (SW_HIDE), same path the task used.
        Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$daemonVbs`"" -WindowStyle Hidden
    } elseif (Test-Path $daemonCmd) {
        Start-Process -FilePath $daemonCmd -WindowStyle Hidden
    }
    # else: no launcher (e.g. portable/dev run) -- tray just reflects health.
}

function Stop-Daemon {
    # Kill whatever listens on the daemon port (the node process the launcher
    # spawned detached -- killing the launcher wouldn't reach it).
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch { }
        }
    } catch { }
}

# --- open-in-browser URL (setup-aware) -------------------------------------
$setupFileCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'aiball\setup-url.txt'),
    (Join-Path $env:PROGRAMDATA  'aiball\logs\setup-url.txt')
)
function Get-OpenUrl {
    try {
        $st = Invoke-RestMethod -Uri "$url/api/auth/status" -TimeoutSec 1 -ErrorAction Stop
        if ($st.ready) { return $url }
    } catch { return $url }
    foreach ($f in $setupFileCandidates) {
        if (Test-Path $f) {
            $line = (Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($line) { return $line.Trim() }
        }
    }
    return $url
}

# Open a URL in the OS DEFAULT browser -- Windows manages the browser choice
# (Settings > Apps > Default apps). Going through explorer.exe does the
# ShellExecute in the running shell's context, so the link lands in the active
# default-browser instance + profile when it is already running (rather than a
# fresh instance launched straight from this Task-Scheduler process).
function Open-Url($u) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList $u
}

# --- tray icon + menu -------------------------------------------------------
$ni = New-Object System.Windows.Forms.NotifyIcon
$icoPath = Join-Path $PSScriptRoot '..\assets\aiball.ico'
$script:baseIcon = if (Test-Path $icoPath) {
    New-Object System.Drawing.Icon $icoPath
} else {
    [System.Drawing.SystemIcons]::Information
}
# Pre-generated proxy overlay icons (fall back to the base if missing).
$script:proxyUpIcon   = Get-IconFile (Join-Path $PSScriptRoot '..\assets\aiball-proxy-up.ico')   $script:baseIcon
$script:proxyDownIcon = Get-IconFile (Join-Path $PSScriptRoot '..\assets\aiball-proxy-down.ico') $script:baseIcon
$ni.Icon = $script:baseIcon
$ni.Text = "aiball - starting..."
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("Open in browser")
$open.Add_Click({ Open-Url (Get-OpenUrl) })
$restart = $menu.Items.Add("Restart daemon")
$restart.Add_Click({ Stop-Daemon; Start-Sleep -Milliseconds 400; Start-Daemon })
$menu.Items.Add("-") | Out-Null
$quit = $menu.Items.Add("Quit aiball")
# Quitting closes the WHOLE app: stop the daemon, then tear down the tray.
$script:quitting = $false
$quit.Add_Click({
    $script:quitting = $true
    Stop-Daemon
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu

$ni.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Open-Url (Get-OpenUrl)
    }
})
$ni.Add_MouseDoubleClick({ Open-Url (Get-OpenUrl) })

# --- supervise: keep the daemon alive, reflect state in the tooltip --------
# Tooltip is the at-a-glance signal (NotifyIcon.Text is capped at 63 chars).
$script:lastStartMs = 0
$script:iconState = $null
function Update-State {
    if ($script:quitting) { return }
    $info = Get-NodeInfo
    if ($info.up) {
        # Recompose the icon only on a transition (proxy on/off, remote up/down).
        $state = "$($info.proxy)|$($info.remoteUp)"
        if ($state -ne $script:iconState) {
            Set-TrayIcon $info.proxy $info.remoteUp
            $script:iconState = $state
        }
        if ($info.proxy) {
            $r = if ($info.remoteUp) { "remote up" } else { "remote DOWN" }
            $ni.Text = "aiball proxy - $r ($url)"
        } else {
            $ni.Text = "aiball - running ($url)"
        }
    } else {
        if ($script:iconState -ne 'down') { Set-TrayIcon $false $false; $script:iconState = 'down' }
        $ni.Text = "aiball - daemon stopped, restarting..."
        # Backoff: at most one (re)start attempt per 10s so a daemon that
        # crash-loops at boot isn't hammered.
        $now = [Environment]::TickCount
        if (($now - $script:lastStartMs) -gt 10000) {
            $script:lastStartMs = $now
            Start-Daemon
        }
    }
}

# Start the daemon now (non-blocking) and show the icon immediately.
Start-Daemon
Update-State

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-State })
$timer.Start()

# WinForms message loop -- alive until "Quit aiball".
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    if ($singletonMutex) {
        try { $singletonMutex.ReleaseMutex() } catch { }
        $singletonMutex.Dispose()
    }
}

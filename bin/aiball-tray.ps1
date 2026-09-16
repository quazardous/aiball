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

# Version wording (pure, tested under pwsh): Get-VersionLook, Get-TrayTooltip.
. (Join-Path $PSScriptRoot 'aiball-tray-version.ps1')

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

# #2089 -- heartbeat. The daemon restarts itself after a pairing by simply
# stopping, and letting the supervision below start it again. It must only do
# that when supervision actually exists, so this file is the proof: written
# every tick, and read by the daemon before it stops. No heartbeat (portable
# run, dev checkout, tray not started) means the daemon refuses to stop and
# tells the user to restart it by hand, which is the safe answer.
#
# Same directory the daemon calls home, resolved the same way it resolves it:
# AIBALL_HOME when set, else the Linux-style default the per-user install
# deliberately reuses on Windows.
$aiballHome = if ($env:AIBALL_HOME) { $env:AIBALL_HOME }
              else { Join-Path $env:USERPROFILE '.local\share\aiball' }
$heartbeatFile = Join-Path $aiballHome 'tray.alive'
function Write-Heartbeat {
    try {
        if (-not (Test-Path $aiballHome)) {
            New-Item -ItemType Directory -Path $aiballHome -Force | Out-Null
        }
        # UTC with a Z, which is what the daemon parses.
        [System.IO.File]::WriteAllText(
            $heartbeatFile,
            [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ'))
    } catch { }
}

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

# --- autostart (Settings > Apps > Startup) ---------------------------------
# A HKCU Run-key entry is the standard Windows autostart visible (and
# disableable) in Settings > Apps > Startup. install.ps1 defaults to a
# scheduled task at logon, which does NOT show in that panel -- so the menu
# toggle exposes the panel-visible mechanism. To make the "off" toggle truly
# off, disabling also turns the scheduled task off; otherwise it would still
# fire at logon and the toggle would be a lie.
$AutostartRunKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AutostartValName = 'aiball-tray'
$AutostartTask    = 'aiball-daemon'   # mirrors install.ps1 $TaskName

function Get-AutostartCommand {
    # Prefer the .vbs tray wrapper (wscript SW_HIDE = no console flash).
    # install.ps1 writes it to %LOCALAPPDATA%\aiball (per-user) or
    # %PROGRAMDATA%\aiball\logs (-System install).
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'aiball\tray-launcher.vbs'),
        (Join-Path $env:PROGRAMDATA  'aiball\logs\tray-launcher.vbs')
    )
    foreach ($v in $candidates) {
        if (Test-Path $v) { return "wscript.exe `"$v`"" }
    }
    # Fallback: launch aiball-tray.cmd directly (brief console flash).
    return "`"$(Join-Path $PSScriptRoot 'aiball-tray.cmd')`""
}

function Test-AutostartRun {
    try {
        $v = Get-ItemProperty -Path $AutostartRunKey -Name $AutostartValName -ErrorAction Stop
        return [bool]$v.$AutostartValName
    } catch { return $false }
}

function Test-AutostartTaskEnabled {
    try {
        $t = Get-ScheduledTask -TaskName $AutostartTask -ErrorAction Stop
        return ($t.State -ne 'Disabled')
    } catch { return $false }
}

function Test-AutostartEnabled {
    return (Test-AutostartRun) -or (Test-AutostartTaskEnabled)
}

function Enable-Autostart {
    if (-not (Test-Path $AutostartRunKey)) {
        New-Item -Path $AutostartRunKey -Force | Out-Null
    }
    Set-ItemProperty -Path $AutostartRunKey -Name $AutostartValName -Value (Get-AutostartCommand) -Type String
}

function Disable-Autostart {
    try { Remove-ItemProperty -Path $AutostartRunKey -Name $AutostartValName -ErrorAction SilentlyContinue } catch { }
    # Also kill the install scheduled task so the OFF toggle really means off.
    try { Disable-ScheduledTask -TaskName $AutostartTask -ErrorAction SilentlyContinue | Out-Null } catch { }
}

# --- version + update check ------------------------------------------------
# `aiball --json version` gives the running / latest versions (from the
# daemon's check at its start) and the update command for THIS install. It is a
# node process, so it runs WITHOUT blocking the message loop: started here, its
# output collected by the timer tick once it has exited.
$script:versionProc = $null
$script:versionOut  = $null
$script:versionLook = Get-VersionLook $null
$script:notifiedVersion = $null
function Start-VersionRead([bool]$check) {
    if ($script:versionProc -and -not $script:versionProc.HasExited) { return }
    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        # The shim install.ps1 writes; `aiball` on PATH otherwise (-Minimal).
        $shim = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\aiball.cmd'
        $exe = if (Test-Path $shim) { "`"$shim`"" } else { 'aiball' }
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = "/d /s /c `"$exe --json version$(if ($check) { ' --check' } else { '' })`""
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $script:versionProc = [System.Diagnostics.Process]::Start($psi)
        $script:versionOut = $script:versionProc.StandardOutput.ReadToEndAsync()
    } catch {
        $script:versionProc = $null
    }
}
function Receive-VersionRead {
    if (-not $script:versionProc -or -not $script:versionProc.HasExited) { return }
    if (-not $script:versionOut.IsCompleted) { return }
    $text = $script:versionOut.Result
    $script:versionProc.Dispose()
    $script:versionProc = $null
    $v = $null
    try { $v = $text | ConvertFrom-Json } catch { }
    Show-Version (Get-VersionLook $v)
}
function Show-Version($look) {
    $script:versionLook = $look
    $versionItem.Text = $look.line
    $copyUpdate.Visible = [bool]$look.command
    $installUpdate.Visible = [bool]$look.command
    $releaseNotes.Visible = [bool]$look.releaseUrl
    # One balloon per release, not one per read.
    if ($look.notifyKey -and $look.notifyKey -ne $script:notifiedVersion) {
        $script:notifiedVersion = $look.notifyKey
        $ni.ShowBalloonTip(10000, 'aiball', "$($look.line). Right-click the icon to copy the update command.", [System.Windows.Forms.ToolTipIcon]::Info)
    }
}

# #2588 -- run the update. install.ps1 replaces the directory this tray runs
# from, and the tray owns the daemon: so the tray stops the daemon, hands over to
# `aiball update --yes` (which starts a runner outside the install dir) and
# quits. The runner relaunches the tray at the end, success or not, and the new
# tray says how it went from update-status.json.
function Invoke-AiballJson([string]$cliArgs, [int]$timeoutMs) {
    try {
        $shim = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\aiball.cmd'
        $exe = if (Test-Path $shim) { "`"$shim`"" } else { 'aiball' }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'cmd.exe'
        $psi.Arguments = "/d /s /c `"$exe --json $cliArgs`""
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEndAsync()
        if (-not $p.WaitForExit($timeoutMs)) { return $null }
        return ($out.Result | ConvertFrom-Json)
    } catch { return $null }
}
function Start-UpdateInstall {
    $c = Get-InstallConfirmation (Invoke-AiballJson 'update --dry-run' 30000)
    if (-not $c.ok) {
        [System.Windows.Forms.MessageBox]::Show($c.text, 'aiball update', 'OK', 'Information') | Out-Null
        return
    }
    $answer = [System.Windows.Forms.MessageBox]::Show($c.text, 'aiball update', 'YesNo', 'Question')
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    $script:quitting = $true
    Stop-Daemon
    $shim = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\aiball.cmd'
    $exe = if (Test-Path $shim) { "`"$shim`"" } else { 'aiball' }
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/d /s /c `"$exe update --yes`"" -WindowStyle Hidden
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

# The last update's outcome, shown once by the tray the runner relaunched.
$updateStatusFile = Join-Path $aiballHome 'update-status.json'
$updateSeenFile   = Join-Path $aiballHome 'update-status.seen'
function Show-UpdateResult {
    try {
        if (-not (Test-Path $updateStatusFile)) { return }
        $status = Get-Content -Raw $updateStatusFile | ConvertFrom-Json
        $seen = if (Test-Path $updateSeenFile) { (Get-Content -Raw $updateSeenFile).Trim() } else { $null }
        $text = Get-UpdateResultBalloon $status $seen
        if (-not $text) { return }
        [System.IO.File]::WriteAllText($updateSeenFile, [string]$status.finished_at)
        $ni.ShowBalloonTip(10000, 'aiball', $text, [System.Windows.Forms.ToolTipIcon]::Info)
    } catch { }
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
$autostart = New-Object System.Windows.Forms.ToolStripMenuItem
$autostart.Text = "Start with Windows"
$autostart.Add_Click({
    if (Test-AutostartEnabled) { Disable-Autostart } else { Enable-Autostart }
})
$menu.Items.Add($autostart) | Out-Null
# Refresh checkmark on each open so external changes (Settings > Apps >
# Startup, Task Scheduler) are reflected the next time the menu pops up.
$menu.Add_Opening({
    $autostart.Checked = (Test-AutostartEnabled)
    Start-VersionRead $false
})
$menu.Items.Add("-") | Out-Null
$versionItem = $menu.Items.Add("version...")
$versionItem.Enabled = $false
$copyUpdate = $menu.Items.Add("Copy the update command")
$copyUpdate.Add_Click({
    if ($script:versionLook.command) { [System.Windows.Forms.Clipboard]::SetText($script:versionLook.command) }
})
$installUpdate = $menu.Items.Add("Install the update")
$installUpdate.Add_Click({ Start-UpdateInstall })
$installUpdate.Visible = $false
$releaseNotes = $menu.Items.Add("Release notes")
$releaseNotes.Add_Click({ if ($script:versionLook.releaseUrl) { Open-Url $script:versionLook.releaseUrl } })
$checkUpdates = $menu.Items.Add("Check for updates")
$checkUpdates.Add_Click({ Start-VersionRead $true })
$copyUpdate.Visible = $false
$releaseNotes.Visible = $false
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
    # Before anything else: say we are here. A daemon about to stop for a
    # restart reads this, and staleness is what tells it to refuse.
    Write-Heartbeat
    Receive-VersionRead
    $info = Get-NodeInfo
    if ($info.up) {
        # A daemon that just came up may run another version: read it again.
        if ($script:iconState -eq 'down' -or $null -eq $script:iconState) { Start-VersionRead $false }
        # Recompose the icon only on a transition (proxy on/off, remote up/down).
        $state = "$($info.proxy)|$($info.remoteUp)"
        if ($state -ne $script:iconState) {
            Set-TrayIcon $info.proxy $info.remoteUp
            $script:iconState = $state
        }
        if ($info.proxy) {
            $r = if ($info.remoteUp) { "remote up" } else { "remote DOWN" }
            $ni.Text = Get-TrayTooltip "proxy, $r" $script:versionLook $url
        } else {
            $ni.Text = Get-TrayTooltip 'running' $script:versionLook $url
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
Show-UpdateResult

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-State })
$timer.Start()

# WinForms message loop -- alive until "Quit aiball".
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    $timer.Stop()
    # Quitting means nothing supervises any more -- stop claiming otherwise.
    try { Remove-Item -Path $heartbeatFile -ErrorAction SilentlyContinue } catch { }
    if ($singletonMutex) {
        try { $singletonMutex.ReleaseMutex() } catch { }
        $singletonMutex.Dispose()
    }
}

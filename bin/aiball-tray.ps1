# aiball-tray.ps1 — system-tray (notification area) icon for the
# Windows install. Right-click menu: open the UI in the browser, or
# exit the tray.
#
# Launched by aiball-tray.cmd (hidden PowerShell). Lives independently
# of the daemon — closing the tray does NOT stop the daemon (which is
# its own scheduled task / service). Same pattern as Slack, Spotify, …
#
# Port: reads AIBALL_PORT env if set, else 7777 (matches daemon-launcher
# default). To change the port the tray points at, edit the desktop /
# Startup shortcut's `Target` or set AIBALL_PORT in your user env.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Singleton: bail out silently if another tray instance is already
# running. Without this, every double-click of the Desktop shortcut
# (or install re-run, or logon firing the Startup folder while a
# previous tray still exists) stacks another icon. Mutex pattern
# matches the way Slack / Discord / VS Code handle launching a
# second instance — second one exits silently.
$mutexName = 'Local\aiball-tray-singleton'
$createdNew = $false
$singletonMutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
    # Another instance owns the mutex. Drop ours and exit.
    $singletonMutex.Dispose()
    exit 0
}

$port = if ($env:AIBALL_PORT) { $env:AIBALL_PORT } else { '7777' }
$url  = "http://127.0.0.1:$port"

# Resolve the URL to open in the browser. Strategy:
#   1. Hit /api/auth/status (public). If ready=true, use root URL.
#   2. If ready=false AND a setup-url.txt file exists (written by
#      install.ps1 when it minted the install token), use that —
#      lands the user directly on the setup form, no token typing.
#   3. Otherwise (daemon unreachable, or no setup file), fall back
#      to the root URL — the SPA will show its own "needs setup" UI.
# Resolved fresh every time the menu is invoked so state changes
# (setup completed mid-session, token rotated, …) are picked up.
$setupFileCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'aiball\setup-url.txt'),
    (Join-Path $env:PROGRAMDATA  'aiball\logs\setup-url.txt')
)
function Get-OpenUrl {
    try {
        $st = Invoke-RestMethod -Uri "$url/api/auth/status" -TimeoutSec 1
        if ($st.ready) { return $url }
    } catch { return $url }   # daemon unreachable — fall back
    foreach ($f in $setupFileCandidates) {
        if (Test-Path $f) {
            $line = (Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($line) { return $line.Trim() }
        }
    }
    return $url
}

$ni = New-Object System.Windows.Forms.NotifyIcon
# Try the bundled .ico first; fall back to a stock SystemIcons placeholder
# if it's missing (e.g. fresh clone before scripts/make-icon.py ran).
$icoPath = Join-Path $PSScriptRoot '..\assets\aiball.ico'
if (Test-Path $icoPath) {
    $ni.Icon = New-Object System.Drawing.Icon $icoPath
} else {
    $ni.Icon = [System.Drawing.SystemIcons]::Information
}
$ni.Text    = "aiball ($url)"   # tooltip on hover
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add("Ouvrir dans le navigateur")
$open.Add_Click({ Start-Process (Get-OpenUrl) })
$menu.Items.Add("-") | Out-Null   # separator
$exit = $menu.Items.Add("Fermer")
$exit.Add_Click({
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu

# Convention: double-click on the tray icon = primary action (open UI).
$ni.Add_MouseDoubleClick({ Start-Process (Get-OpenUrl) })

# Hand control to the WinForms message loop. The script stays alive
# until "Fermer" is clicked. Release the singleton mutex on exit so a
# fresh launch can take over cleanly.
try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($singletonMutex) {
        try { $singletonMutex.ReleaseMutex() } catch { }
        $singletonMutex.Dispose()
    }
}

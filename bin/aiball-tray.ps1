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

$port = if ($env:AIBALL_PORT) { $env:AIBALL_PORT } else { '7777' }
$url  = "http://127.0.0.1:$port"

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
$open.Add_Click({ Start-Process $url })
$menu.Items.Add("-") | Out-Null   # separator
$exit = $menu.Items.Add("Fermer")
$exit.Add_Click({
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu

# Convention: double-click on the tray icon = primary action (open UI).
$ni.Add_MouseDoubleClick({ Start-Process $url })

# Hand control to the WinForms message loop. The script stays alive
# until "Fermer" is clicked.
[System.Windows.Forms.Application]::Run()

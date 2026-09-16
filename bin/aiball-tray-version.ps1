# aiball-tray-version.ps1 -- what the tray says about versions, as a pure
# function the tray dot-sources (and a test runs under pwsh, no WinForms).
#
# Input: the object `aiball --json version` prints. The CLI owns the facts: the
# daemon's last check of the latest release, and the update command for THIS
# install, built from the installer's record. The tray only words them.
#
# Keep this file ASCII-only, like aiball-tray.ps1 (Windows PowerShell 5.1 reads
# a BOM-less file as the system codepage).

function Get-VersionLook($v) {
    $look = @{ line = 'version unknown'; command = $null; releaseUrl = $null; notifyKey = $null; running = $null; restart = $false }
    if (-not $v) { return $look }
    $d = $v.daemon
    if (-not $d) { $look.line = "aiball $($v.cli) - daemon not reachable"; return $look }
    $look.running = $d.running
    if ($d.restart_needed) {
        $look.line = "aiball $($d.running) runs, $($d.installed) is installed - restart the daemon"
        $look.restart = $true
    } elseif ($d.check_disabled) {
        $look.line = "aiball $($d.running) - update check off"
    } elseif ($d.update_available -and $d.latest) {
        $look.line = "aiball $($d.running) - $($d.latest) is available"
        $look.command = $v.update_command
        $look.releaseUrl = $d.release_url
        $look.notifyKey = $d.latest
    } elseif ($d.latest) {
        $look.line = "aiball $($d.running) - up to date"
    } elseif ($d.error) {
        $look.line = "aiball $($d.running) - could not check for updates"
    } else {
        $look.line = "aiball $($d.running)"
    }
    return $look
}

# NotifyIcon.Text is capped at 63 characters: say the state, then the version
# news, then the URL, dropping from the end until it fits.
function Get-TrayTooltip([string]$state, $look, [string]$url) {
    $ver = if ($look -and $look.running) { " $($look.running)" } else { '' }
    $news = if ($look -and $look.notifyKey) { ", $($look.notifyKey) available" }
            elseif ($look -and $look.restart) { ', restart needed' }
            else { '' }
    foreach ($t in @("aiball$ver - $state$news ($url)", "aiball$ver - $state$news", "aiball - $state$news", "aiball - $state")) {
        if ($t.Length -le 63) { return $t }
    }
    return $t.Substring(0, 63)
}

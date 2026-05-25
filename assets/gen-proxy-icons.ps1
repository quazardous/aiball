# Regenerate the proxy tray-icon variants from the base icon:
#   assets/aiball-proxy-up.ico    (green upward "uplink" arrow -- remote healthy)
#   assets/aiball-proxy-down.ico  (red   upward "uplink" arrow -- remote down)
#
# Each frame of assets/aiball.ico (a 7-size PNG icon: 16..256) gets the arrow
# overlay drawn at that frame's NATIVE size, then all frames are packed back
# into one multi-resolution PNG .ico. The tray loads these FILES directly
# (Set-TrayIcon) and never composes/scales at runtime -- runtime composition
# produced only a 32x32 frame that the notification area downscaled into "snow".
#
# Run after changing the arrow geometry or colours:
#   powershell -ExecutionPolicy Bypass -File assets\gen-proxy-icons.ps1
# Keep this file ASCII-only (see aiball-tray.ps1 header).

Add-Type -AssemblyName System.Drawing

$assets    = Split-Path -Parent $MyInvocation.MyCommand.Path
$baseBytes = [System.IO.File]::ReadAllBytes((Join-Path $assets 'aiball.ico'))

# Upward arrow polygon as fractions of the icon size (bottom-right badge).
$norm = @(
    @(0.750, 0.406), @(0.969, 0.688), @(0.844, 0.688),
    @(0.844, 0.969), @(0.656, 0.969), @(0.656, 0.688), @(0.531, 0.688)
)

function Read-BaseFrames($bytes) {
    $count  = [BitConverter]::ToUInt16($bytes, 4)
    $frames = @()
    for ($i = 0; $i -lt $count; $i++) {
        $o    = 6 + $i * 16
        $size = [BitConverter]::ToUInt32($bytes, $o + 8)
        $off  = [BitConverter]::ToUInt32($bytes, $o + 12)
        $png  = New-Object byte[] $size
        [Array]::Copy($bytes, $off, $png, 0, $size)
        $frames += , @{ wbyte = $bytes[$o]; hbyte = $bytes[$o + 1]; png = $png }
    }
    return $frames
}

function Build-Ico($color, $outPath) {
    $frames = Read-BaseFrames $baseBytes
    $brush  = New-Object System.Drawing.SolidBrush $color
    $pen    = New-Object System.Drawing.Pen ([System.Drawing.Color]::White)
    $blobs  = @()
    foreach ($fr in $frames) {
        $ms  = New-Object System.IO.MemoryStream (, $fr.png)
        $img = [System.Drawing.Image]::FromStream($ms)
        $s   = $img.Width
        $bmp = New-Object System.Drawing.Bitmap $img.Width, $img.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($img, 0, 0, $img.Width, $img.Height)
        $pts = foreach ($p in $norm) {
            New-Object System.Drawing.Point ([int][Math]::Round($p[0] * $s)), ([int][Math]::Round($p[1] * $s))
        }
        $pts = [System.Drawing.Point[]]$pts
        $g.FillPolygon($brush, $pts)
        $pen.Width = [float][Math]::Max(1.0, $s / 20.0)
        $g.DrawPolygon($pen, $pts)
        $g.Dispose()
        $o = New-Object System.IO.MemoryStream
        $bmp.Save($o, [System.Drawing.Imaging.ImageFormat]::Png)
        $blobs += , ($o.ToArray())
        $bmp.Dispose(); $img.Dispose(); $ms.Dispose(); $o.Dispose()
    }
    $fs = [System.IO.File]::Create($outPath)
    $bw = New-Object System.IO.BinaryWriter($fs)
    $n  = $blobs.Count
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$n)
    $offset = 6 + 16 * $n
    for ($i = 0; $i -lt $n; $i++) {
        $fr = $frames[$i]; $len = $blobs[$i].Length
        $bw.Write([Byte]$fr.wbyte); $bw.Write([Byte]$fr.hbyte)  # 0 => 256, as in the base
        $bw.Write([Byte]0); $bw.Write([Byte]0)
        $bw.Write([UInt16]1); $bw.Write([UInt16]32)
        $bw.Write([UInt32]$len); $bw.Write([UInt32]$offset)
        $offset += $len
    }
    foreach ($blob in $blobs) { $bw.Write($blob) }
    $bw.Flush(); $bw.Close(); $fs.Close()
    Write-Output ("wrote {0} ({1} frames)" -f $outPath, $n)
}

Build-Ico ([System.Drawing.Color]::LimeGreen) (Join-Path $assets 'aiball-proxy-up.ico')
Build-Ico ([System.Drawing.Color]::Red)       (Join-Path $assets 'aiball-proxy-down.ico')

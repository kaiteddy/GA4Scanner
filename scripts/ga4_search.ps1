# GA4 combined Quick-Search helper (DPI-AWARE).
# Usage: ga4_search.ps1 "<term>" [out.png]
# Focuses GA4, closes any open search dialog (ESC), opens Quick Search,
# clears it, types <term>, presses Enter, waits for results, screenshots.
param(
  [Parameter(Mandatory=$true)][string]$Term,
  [string]$Out
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@ 2>$null
[Dpi]::SetProcessDPIAware() | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class G {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
}
public struct RECT { public int Left, Top, Right, Bottom; }
"@
$LEFTDOWN=0x0002; $LEFTUP=0x0004; $KEYUP=0x0002

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" } | Select-Object -First 1
if (-not $proc) { Write-Output "GA4_NOT_FOUND"; exit 1 }
$hwnd = $proc.MainWindowHandle
if ([G]::IsIconic($hwnd)) { [G]::ShowWindow($hwnd,9) | Out-Null; Start-Sleep -Milliseconds 300 }
[G]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 400

$r = New-Object RECT; [G]::GetWindowRect($hwnd,[ref]$r) | Out-Null

function Key([byte]$vk) {
  [G]::keybd_event($vk,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40
  [G]::keybd_event($vk,0,$KEYUP,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
}
function Click([int]$ix,[int]$iy) {
  $sx = $r.Left + $ix; $sy = $r.Top + $iy
  [G]::SetCursorPos($sx,$sy) | Out-Null; Start-Sleep -Milliseconds 120
  [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
  [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 300
}

# 1) Close any open Quick Search dialog via its red X (img coords in physical px).
#    If no dialog is open this lands in the list area (harmless row select).
Click 2208 630
Start-Sleep -Milliseconds 500

# 2) Click the toolbar Quick Search box.
Click 178 206

# 3) Select-all + type term + Enter.
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 150
# Escape SendKeys special chars in the term
$safe = $Term -replace '([+^%~(){}])','{$1}'
[System.Windows.Forms.SendKeys]::SendWait($safe)
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 3500

# 4) Screenshot.
[G]::GetWindowRect($hwnd,[ref]$r) | Out-Null
$w = $r.Right-$r.Left; $h = $r.Bottom-$r.Top
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap($w,$h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$h)))
$outp = if ($Out) { $Out } else { "$env:TEMP\ga4_search.png" }
$bmp.Save($outp,[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "term='$Term' rect=($($r.Left),$($r.Top)) size=${w}x${h} saved=$outp"

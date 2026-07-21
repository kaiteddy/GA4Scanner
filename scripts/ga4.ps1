# GA4 native-Windows automation helper (DPI-AWARE).
# Subcommands:
#   shot  <out.png>
#   click <imgX> <imgY> [out.png]
#   type  <text> [out.png]
#   key   <vk-hex> [out.png]     e.g. key 0x1B  (Escape), key 0x0D (Enter)
# All image coords are in FULL PHYSICAL pixels of the captured window (window top-left = 0,0).
param(
  [Parameter(Mandatory=$true)][string]$Cmd,
  [string]$A1, [string]$A2, [string]$A3, [string]$A4, [string]$A5
)

# --- Make THIS process DPI-aware BEFORE any GDI/cursor use ---
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@ 2>$null
[Dpi]::SetProcessDPIAware() | Out-Null

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class G {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
}
public struct RECT { public int Left, Top, Right, Bottom; }
public struct PT { public int X, Y; }
"@
$LEFTDOWN=0x0002; $LEFTUP=0x0004; $KEYUP=0x0002

function Get-GA4 {
  $p = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" } | Select-Object -First 1
  if (-not $p) { Write-Output "GA4_NOT_FOUND"; exit 1 }
  return $p
}
function Focus-GA4($hwnd) {
  if ([G]::IsIconic($hwnd)) { [G]::ShowWindow($hwnd,9) | Out-Null; Start-Sleep -Milliseconds 300 }
  [G]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 400
}
function Rect-GA4($hwnd) { $r = New-Object RECT; [G]::GetWindowRect($hwnd,[ref]$r) | Out-Null; return $r }
function Capture($hwnd,$out) {
  $r = Rect-GA4 $hwnd
  $w = $r.Right-$r.Left; $h = $r.Bottom-$r.Top
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($w,$h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$h)))
  $bmp.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "rect=($($r.Left),$($r.Top)) size=${w}x${h} saved=$out"
}

$proc = Get-GA4
$hwnd = $proc.MainWindowHandle

switch ($Cmd) {
  "shot" {
    Focus-GA4 $hwnd
    $out = if ($A1) { $A1 } else { "$env:TEMP\ga4_shot.png" }
    Capture $hwnd $out
  }
  "click" {
    Focus-GA4 $hwnd
    $r = Rect-GA4 $hwnd
    $sx = $r.Left + [int]$A1; $sy = $r.Top + [int]$A2
    [G]::SetCursorPos($sx,$sy) | Out-Null; Start-Sleep -Milliseconds 150
    $p = New-Object PT; [G]::GetCursorPos([ref]$p) | Out-Null
    Write-Output "img=($A1,$A2) -> screen=($sx,$sy) cursor=($($p.X),$($p.Y))"
    [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
    [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 1200
    $out = if ($A3) { $A3 } else { "$env:TEMP\ga4_after.png" }
    Capture $hwnd $out
  }
  "dclick" {
    Focus-GA4 $hwnd
    $r = Rect-GA4 $hwnd
    $sx = $r.Left + [int]$A1; $sy = $r.Top + [int]$A2
    [G]::SetCursorPos($sx,$sy) | Out-Null; Start-Sleep -Milliseconds 150
    Write-Output "img=($A1,$A2) -> screen=($sx,$sy)"
    [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40
    [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
    [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40
    [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 1500
    $out = if ($A3) { $A3 } else { "$env:TEMP\ga4_after.png" }
    Capture $hwnd $out
  }
  "type" {
    Focus-GA4 $hwnd
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait($A1)
    Start-Sleep -Milliseconds 800
    $out = if ($A2) { $A2 } else { "$env:TEMP\ga4_after.png" }
    Capture $hwnd $out
  }
  "gridrow" {
    # Atomic line-item entry via KEYBOARD Tab-nav, so a preset autocomplete popup can't block the
    # Qty/Price cell clicks (that popup is why preset-matching labour like "Mechanical Labour" failed).
    # $A1=descImgX $A2=rowY $A3=desc $A4=qty $A5=price. Cols: Desc|Tech|Qty|UnitPrice -> desc,Tab,Tab=Qty,Tab=Price.
    Focus-GA4 $hwnd
    $r = Rect-GA4 $hwnd
    $sx = $r.Left + [int]$A1; $sy = $r.Top + [int]$A2
    [G]::SetCursorPos($sx,$sy) | Out-Null; Start-Sleep -Milliseconds 150
    [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
    [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 450
    Add-Type -AssemblyName System.Windows.Forms
    $SK = [System.Windows.Forms.SendKeys]
    $SK::SendWait("^a"); Start-Sleep -Milliseconds 120
    $safe = $A3 -replace '([+^%~(){}])','{$1}'
    $SK::SendWait($safe); Start-Sleep -Milliseconds 350                 # desc (autocomplete may appear)
    $SK::SendWait("{TAB}"); Start-Sleep -Milliseconds 300               # commit desc -> Tech
    $SK::SendWait("{TAB}"); Start-Sleep -Milliseconds 300               # Tech -> Qty
    $SK::SendWait("^a"); Start-Sleep -Milliseconds 80; $SK::SendWait($A4); Start-Sleep -Milliseconds 250
    $SK::SendWait("{TAB}"); Start-Sleep -Milliseconds 300               # Qty -> Unit Price
    $SK::SendWait("^a"); Start-Sleep -Milliseconds 80; $SK::SendWait($A5); Start-Sleep -Milliseconds 250
    $SK::SendWait("{TAB}"); Start-Sleep -Milliseconds 500               # commit row
    Write-Output "gridrow ($A1,$A2) desc='$A3' qty=$A4 price=$A5"
    Capture $hwnd "$env:TEMP\ga4_after.png"
  }
  "cell" {
    # Atomic line-item cell entry: Focus -> click (imgX imgY) -> select-all -> type -> Tab commit.
    # ALL in one process so foreground/focus cannot drift between click and keystrokes
    # (that drift was the bug: bare SendKeys in a separate process missed the focused cell).
    Focus-GA4 $hwnd
    $r = Rect-GA4 $hwnd
    $sx = $r.Left + [int]$A1; $sy = $r.Top + [int]$A2
    [G]::SetCursorPos($sx,$sy) | Out-Null; Start-Sleep -Milliseconds 150
    [G]::mouse_event($LEFTDOWN,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 60
    [G]::mouse_event($LEFTUP,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 400
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 150
    $safe = $A3 -replace '([+^%~(){}])','{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($safe); Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}"); Start-Sleep -Milliseconds 500
    Write-Output "cell ($A1,$A2) = '$A3'"
    Capture $hwnd "$env:TEMP\ga4_after.png"
  }
  "key" {
    Focus-GA4 $hwnd
    $vk = [Convert]::ToByte($A1,16)
    [G]::keybd_event($vk,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 40
    [G]::keybd_event($vk,0,$KEYUP,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 800
    $out = if ($A2) { $A2 } else { "$env:TEMP\ga4_after.png" }
    Capture $hwnd $out
  }
  default { Write-Output "unknown cmd: $Cmd" }
}
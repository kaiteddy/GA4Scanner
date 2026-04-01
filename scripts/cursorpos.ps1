param([int]$X, [int]$Y)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CursorHelper {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
}
"@

Write-Output "Screen: $([CursorHelper]::GetSystemMetrics(0))x$([CursorHelper]::GetSystemMetrics(1))"

if ($X -gt 0 -or $Y -gt 0) {
    [CursorHelper]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 100
}

$p = New-Object CursorHelper+POINT
[CursorHelper]::GetCursorPos([ref]$p)
Write-Output "Cursor at: $($p.X),$($p.Y)"

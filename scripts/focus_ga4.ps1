Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class WinActivator {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

# Simple approach: find GA4 window by title using FindWindow
$hwnd = [WinActivator]::FindWindow([NullString]::Value, "Garage Assistant GA4 - [v4.046 Standalone]")
if ($hwnd -ne [IntPtr]::Zero) {
    [WinActivator]::ShowWindow($hwnd, 9)
    [WinActivator]::SetForegroundWindow($hwnd)
    Write-Output "Focused GA4 window"
} else {
    # Try partial match by enumerating
    $proc = Get-Process | Where-Object { $_.ProcessName -like '*Garage*' } | Select-Object -First 1
    if ($proc) {
        # Use Alt+Tab approach via SendKeys
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait("%{TAB}")
        Start-Sleep -Milliseconds 500
        Write-Output "Sent Alt+Tab (GA4 PID=$($proc.Id))"
    } else {
        Write-Output "GA4 not running"
    }
}

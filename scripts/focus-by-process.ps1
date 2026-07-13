# Focus GA4 by Process
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@

Write-Host "Finding GA4 by process..." -ForegroundColor Cyan

# Find GA4 process
$ga4Process = Get-Process | Where-Object { $_.ProcessName -eq "Garage Assistant GA4" } | Select-Object -First 1

if (-not $ga4Process) {
    Write-Host "GA4 process not found!" -ForegroundColor Red
    exit 1
}

Write-Host "Found process: $($ga4Process.ProcessName) (PID: $($ga4Process.Id))" -ForegroundColor Green
Write-Host "Main window handle: $($ga4Process.MainWindowHandle)" -ForegroundColor Gray

$hwnd = $ga4Process.MainWindowHandle

if ($hwnd -eq 0) {
    Write-Host "No main window handle!" -ForegroundColor Red
    exit 1
}

# Restore if minimized
if ([WinAPI]::IsIconic($hwnd)) {
    Write-Host "Window is minimized - restoring..." -ForegroundColor Yellow
    [WinAPI]::ShowWindow($hwnd, 9) | Out-Null  # SW_RESTORE
    Start-Sleep -Milliseconds 200
}

# Bring to foreground
Write-Host "Setting foreground..." -ForegroundColor Yellow
[WinAPI]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 300

# Verify
$fg = [WinAPI]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 256
[WinAPI]::GetWindowText($fg, $title, 256) | Out-Null

if ($fg -eq $hwnd) {
    Write-Host "SUCCESS! GA4 is now foreground" -ForegroundColor Green
    Write-Host "Title: $($title.ToString())" -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAILED - Foreground is: $($title.ToString())" -ForegroundColor Red
    Write-Host "Expected handle: $hwnd, Got: $fg" -ForegroundColor Red
    exit 1
}

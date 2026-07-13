# Verified GA4 Focus - Retry until confirmed
param([int]$MaxRetries = 10)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinAPI {
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$SW_RESTORE = 9
$targetTitle = "Garage Assistant GA4 - [v4.046 Standalone]"

Write-Host "Focusing GA4 with verification..." -ForegroundColor Cyan

for ($i = 1; $i -le $MaxRetries; $i++) {
    Write-Host "  Attempt $i/$MaxRetries..." -ForegroundColor Yellow

    # Find GA4 window
    $hwnd = [WinAPI]::FindWindow($null, $targetTitle)

    if ($hwnd -eq [IntPtr]::Zero) {
        Write-Host "    GA4 window not found!" -ForegroundColor Red
        Start-Sleep -Milliseconds 500
        continue
    }

    # Restore and bring to foreground
    [WinAPI]::ShowWindow($hwnd, $SW_RESTORE) | Out-Null
    Start-Sleep -Milliseconds 100
    [WinAPI]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 300

    # Verify it's now foreground
    $fg = [WinAPI]::GetForegroundWindow()
    $title = New-Object System.Text.StringBuilder 256
    [WinAPI]::GetWindowText($fg, $title, 256) | Out-Null

    if ($fg -eq $hwnd) {
        Write-Host "    SUCCESS - GA4 is now foreground!" -ForegroundColor Green
        Write-Host "    Window: $($title.ToString())" -ForegroundColor Green
        return $true
    } else {
        Write-Host "    FAILED - Foreground is: $($title.ToString())" -ForegroundColor Red
        Start-Sleep -Milliseconds 500
    }
}

Write-Host "FAILED after $MaxRetries attempts" -ForegroundColor Red
return $false

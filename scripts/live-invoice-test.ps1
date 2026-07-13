# Live Invoice Workflow Test
# Tests actual GA4 operations on draft 90750

Write-Host "=== LIVE INVOICE WORKFLOW TEST ===" -ForegroundColor Cyan
Write-Host "Testing on: Draft 90750 (RO12 YBT - Ambassador)" -ForegroundColor Gray
Write-Host ""

# Load required assemblies
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Helper: Take screenshot
function Take-Screenshot {
    param([string]$Name)

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)

    $path = "C:\Users\ELI MOTOTRS LTD\test-$Name.png"
    $bitmap.Save($path)

    $graphics.Dispose()
    $bitmap.Dispose()

    return $path
}

# Helper: Load click script
function Invoke-Click {
    param([int]$X, [int]$Y)

    $sw = [Diagnostics.Stopwatch]::StartNew()

    # Use the GA4Scanner click script
    $clickScript = Get-Content "C:\Users\ELI MOTOTRS LTD\GA4Scanner\scripts\click.ps1" -Raw
    $scriptBlock = [scriptblock]::Create($clickScript)
    & $scriptBlock $X $Y | Out-Null

    $sw.Stop()
    return $sw.ElapsedMilliseconds
}

# Helper: Clipboard operation
function Test-ClipboardPaste {
    param([string]$Text)

    $sw = [Diagnostics.Stopwatch]::StartNew()

    # Set clipboard
    [Windows.Forms.Clipboard]::SetText($Text)
    Start-Sleep -Milliseconds 100

    # Verify it's set
    $readBack = [Windows.Forms.Clipboard]::GetText()

    $sw.Stop()

    return @{
        Success = ($readBack -eq $Text)
        Time = $sw.ElapsedMilliseconds
        Expected = $Text
        Actual = $readBack
    }
}

Write-Host "[SETUP] Taking baseline screenshot..." -ForegroundColor Yellow
$baseline = Take-Screenshot "baseline"
Write-Host "  Saved: $baseline" -ForegroundColor Green
Write-Host ""

# TEST 1: Click Precision on Existing Parts Line
Write-Host "[TEST 1] Click Precision - Existing Parts Row" -ForegroundColor Yellow
Write-Host "  Target: 'Air Con Re-Gas - R134a (450g)' Description field" -ForegroundColor Gray

# Based on screenshot, the Description field in first parts row is approximately:
# X: ~490 (middle of Description column)
# Y: ~726 (first data row)

$clickTime = Invoke-Click 490 726
Start-Sleep -Milliseconds 300

$after1 = Take-Screenshot "after-click-parts-desc"
Write-Host "  Click executed in: ${clickTime}ms" -ForegroundColor Cyan
Write-Host "  Screenshot: $after1" -ForegroundColor Green
Write-Host ""

# TEST 2: Click on Empty Parts Row (Part Lookup)
Write-Host "[TEST 2] Click Precision - Empty Parts Row" -ForegroundColor Yellow
Write-Host "  Target: Second row 'Part Lookup' placeholder" -ForegroundColor Gray

# Second row Part Lookup is approximately at Y: ~765
$clickTime2 = Invoke-Click 189 765
Start-Sleep -Milliseconds 300

$after2 = Take-Screenshot "after-click-part-lookup"
Write-Host "  Click executed in: ${clickTime2}ms" -ForegroundColor Cyan
Write-Host "  Screenshot: $after2" -ForegroundColor Green
Write-Host ""

# TEST 3: Clipboard Paste Operation
Write-Host "[TEST 3] Clipboard Paste Reliability" -ForegroundColor Yellow
Write-Host "  Testing clipboard with special characters..." -ForegroundColor Gray

$testStrings = @(
    "Test Part 123",
    "Air Con & Heating",
    "MOT (Class 4)",
    "Oil Change - 5W-30"
)

$pasteResults = @()
foreach ($testStr in $testStrings) {
    $result = Test-ClipboardPaste $testStr
    $pasteResults += $result

    $status = if ($result.Success) { "PASS" } else { "FAIL" }
    $color = if ($result.Success) { "Green" } else { "Red" }

    Write-Host "  $status '$($testStr)' ($($result.Time)ms)" -ForegroundColor $color
    if (-not $result.Success) {
        Write-Host "    Expected: $($result.Expected)" -ForegroundColor Red
        Write-Host "    Got: $($result.Actual)" -ForegroundColor Red
    }
}

$pasteSuccessRate = ($pasteResults | Where-Object { $_.Success }).Count / $pasteResults.Count * 100
Write-Host "  Success Rate: $pasteSuccessRate%" -ForegroundColor $(if($pasteSuccessRate -eq 100){"Green"}else{"Red"})
Write-Host ""

# TEST 4: Tab Navigation
Write-Host "[TEST 4] Tab Key Navigation" -ForegroundColor Yellow
Write-Host "  Testing field navigation..." -ForegroundColor Gray

# Load keyboard script
$typeScript = Get-Content "C:\Users\ELI MOTOTRS LTD\GA4Scanner\scripts\type.ps1" -Raw

# First, click on a known field (Qty field in first parts row - approximately X:780, Y:726)
Invoke-Click 780 726 | Out-Null
Start-Sleep -Milliseconds 200

# Now press Tab 3 times to navigate through fields
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class KeyboardAPI {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
}
"@

$VK_TAB = 0x09
$KEYEVENTF_KEYDOWN = 0x0000
$KEYEVENTF_KEYUP = 0x0002

$sw = [Diagnostics.Stopwatch]::StartNew()

for ($i = 1; $i -le 3; $i++) {
    [KeyboardAPI]::keybd_event($VK_TAB, 0, $KEYEVENTF_KEYDOWN, 0)
    Start-Sleep -Milliseconds 50
    [KeyboardAPI]::keybd_event($VK_TAB, 0, $KEYEVENTF_KEYUP, 0)
    Start-Sleep -Milliseconds 150
}

$sw.Stop()

$after4 = Take-Screenshot "after-tab-navigation"
Write-Host "  3 Tab presses executed in: $($sw.ElapsedMilliseconds)ms" -ForegroundColor Cyan
Write-Host "  Screenshot: $after4" -ForegroundColor Green
Write-Host ""

# TEST 5: Small Target Click (Dropdown VAT code)
Write-Host "[TEST 5] Small Target Click - VAT Dropdown" -ForegroundColor Yellow
Write-Host "  Target: VAT code dropdown (T1) - small target test" -ForegroundColor Gray

# VAT dropdown button is approximately at X:1044, Y:725 (very small target)
$clickTime5 = Invoke-Click 1044 725
Start-Sleep -Milliseconds 400  # Give dropdown time to open

$after5 = Take-Screenshot "after-vat-dropdown"
Write-Host "  Click executed in: ${clickTime5}ms" -ForegroundColor Cyan
Write-Host "  Screenshot: $after5" -ForegroundColor Green
Write-Host ""

# If dropdown opened, close it with Escape
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EscapeKey {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
}
"@

$VK_ESCAPE = 0x1B
[EscapeKey]::keybd_event($VK_ESCAPE, 0, 0x0000, 0)
Start-Sleep -Milliseconds 50
[EscapeKey]::keybd_event($VK_ESCAPE, 0, 0x0002, 0)
Start-Sleep -Milliseconds 200

# FINAL: Return to baseline
Write-Host "[CLEANUP] Taking final screenshot..." -ForegroundColor Yellow
$final = Take-Screenshot "final"
Write-Host "  Saved: $final" -ForegroundColor Green
Write-Host ""

# SUMMARY
Write-Host "=== TEST SUMMARY ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Screenshots saved to C:\Users\ELI MOTOTRS LTD\" -ForegroundColor Gray
Write-Host "  - test-baseline.png (starting state)" -ForegroundColor Gray
Write-Host "  - test-after-click-parts-desc.png (Test 1)" -ForegroundColor Gray
Write-Host "  - test-after-click-part-lookup.png (Test 2)" -ForegroundColor Gray
Write-Host "  - test-after-tab-navigation.png (Test 4)" -ForegroundColor Gray
Write-Host "  - test-after-vat-dropdown.png (Test 5)" -ForegroundColor Gray
Write-Host "  - test-final.png (end state)" -ForegroundColor Gray
Write-Host ""
Write-Host "Click Times:" -ForegroundColor Yellow
Write-Host "  Test 1 (Parts Description): ${clickTime}ms" -ForegroundColor Cyan
Write-Host "  Test 2 (Part Lookup): ${clickTime2}ms" -ForegroundColor Cyan
Write-Host "  Test 5 (VAT Dropdown): ${clickTime5}ms" -ForegroundColor Cyan
Write-Host ""
Write-Host "Clipboard Paste Success: $pasteSuccessRate%" -ForegroundColor $(if($pasteSuccessRate -eq 100){"Green"}else{"Red"})
Write-Host ""
Write-Host "Compare screenshots to verify:" -ForegroundColor Yellow
Write-Host "  - Did clicks land in correct fields?" -ForegroundColor Gray
Write-Host "  - Did dropdown open on Test 5?" -ForegroundColor Gray
Write-Host "  - Did Tab navigation move focus correctly?" -ForegroundColor Gray
Write-Host ""
Write-Host "LIVE TEST COMPLETE" -ForegroundColor Cyan

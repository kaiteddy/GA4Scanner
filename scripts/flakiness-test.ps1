# Comprehensive Flakiness Diagnostic
# Tests the specific issues documented in GA4Scanner

Write-Host "=== GA4 FLAKINESS DIAGNOSTIC ===" -ForegroundColor Cyan
Write-Host ""

# Helper function to check window focus
function Test-GA4Focus {
    Add-Type -AssemblyName System.Windows.Forms
    $foreground = [System.Windows.Forms.Application]::OpenForms | Select-Object -First 1
    $processes = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" }

    if ($processes) {
        $ga4 = $processes[0]
        $ga4Handle = $ga4.MainWindowHandle

        # Get foreground window
        Add-Type @"
            using System;
            using System.Runtime.InteropServices;
            public class WinAPI {
                [DllImport("user32.dll")]
                public static extern IntPtr GetForegroundWindow();
            }
"@
        $fgWindow = [WinAPI]::GetForegroundWindow()

        $isFocused = ($ga4Handle -eq $fgWindow)
        return @{
            IsFocused = $isFocused
            Handle = $ga4Handle.ToString()
            ForegroundHandle = $fgWindow.ToString()
        }
    }
    return $null
}

# Test 1: Window Focus Stability
Write-Host "[TEST 1] Window Focus Stability" -ForegroundColor Yellow
Write-Host "  Testing if GA4 maintains focus during operations..." -ForegroundColor Gray

$focus1 = Test-GA4Focus
if ($focus1) {
    Write-Host "  Initial focus: $($focus1.IsFocused)" -ForegroundColor $(if($focus1.IsFocused){"Green"}else{"Red"})

    # Simulate a click operation delay
    Start-Sleep -Milliseconds 500

    $focus2 = Test-GA4Focus
    Write-Host "  After 500ms: $($focus2.IsFocused)" -ForegroundColor $(if($focus2.IsFocused){"Green"}else{"Red"})

    if ($focus1.IsFocused -and $focus2.IsFocused) {
        Write-Host "  ✓ Focus STABLE" -ForegroundColor Green
    } else {
        Write-Host "  ✗ Focus LOST - this causes click failures!" -ForegroundColor Red
    }
} else {
    Write-Host "  ✗ GA4 not found" -ForegroundColor Red
}
Write-Host ""

# Test 2: Clipboard Sequence Reliability
Write-Host "[TEST 2] Clipboard Sequence Test (10 rapid writes)" -ForegroundColor Yellow
Add-Type -AssemblyName System.Windows.Forms

$failures = 0
for ($i = 1; $i -le 10; $i++) {
    $testValue = "TEST_$i"
    [System.Windows.Forms.Clipboard]::SetText($testValue)
    Start-Sleep -Milliseconds 50
    $readValue = [System.Windows.Forms.Clipboard]::GetText()

    if ($readValue -ne $testValue) {
        $failures++
        Write-Host "  ✗ Iteration $i FAILED: wrote '$testValue', got '$readValue'" -ForegroundColor Red
    }
}

if ($failures -eq 0) {
    Write-Host "  ✓ All 10 iterations succeeded" -ForegroundColor Green
} else {
    Write-Host "  ✗ $failures/$10 iterations failed" -ForegroundColor Red
}
Write-Host ""

# Test 3: Click Timing Test
Write-Host "[TEST 3] Click Response Timing" -ForegroundColor Yellow
Write-Host "  Measuring how long clicks take..." -ForegroundColor Gray

$clickTimes = @()
for ($i = 1; $i -le 5; $i++) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # Load and execute click script
    $clickScript = Get-Content "C:\Users\ELI MOTOTRS LTD\GA4Scanner\scripts\click.ps1" -Raw
    $scriptBlock = [scriptblock]::Create($clickScript)
    & $scriptBlock 100 100  # Click at safe coordinates

    $sw.Stop()
    $clickTimes += $sw.ElapsedMilliseconds
}

$avgTime = ($clickTimes | Measure-Object -Average).Average
$minTime = ($clickTimes | Measure-Object -Minimum).Minimum
$maxTime = ($clickTimes | Measure-Object -Maximum).Maximum

Write-Host "  Average: $($avgTime)ms, Min: $($minTime)ms, Max: $($maxTime)ms" -ForegroundColor Cyan
if ($avgTime -lt 100) {
    Write-Host "  ✓ Fast clicks (< 100ms avg)" -ForegroundColor Green
} elseif ($avgTime -lt 300) {
    Write-Host "  ⚠ Moderate speed (100-300ms avg)" -ForegroundColor Yellow
} else {
    Write-Host "  ✗ Slow clicks (> 300ms avg) - performance issue!" -ForegroundColor Red
}
Write-Host ""

# Test 4: Screen Resolution Consistency
Write-Host "[TEST 4] Screen Resolution Check" -ForegroundColor Yellow
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$width = $screen.Bounds.Width
$height = $screen.Bounds.Height

Write-Host "  Current: ${width}x${height}" -ForegroundColor Cyan
Write-Host "  Expected by GA4Scanner: 1200px wide screenshot (scaled from ~1514x1191)" -ForegroundColor Gray

if ($width -eq 1514 -and $height -eq 1191) {
    Write-Host "  ✓ Resolution matches GA4Scanner expectations" -ForegroundColor Green
} else {
    Write-Host "  ⚠ Resolution changed - coordinate mapping may be off!" -ForegroundColor Yellow
    Write-Host "    GA4Scanner expects ~1514x1191, got ${width}x${height}" -ForegroundColor Yellow
}
Write-Host ""

# Test 5: Process Health
Write-Host "[TEST 5] GA4 Process Health" -ForegroundColor Yellow
$ga4Process = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" } | Select-Object -First 1

if ($ga4Process) {
    Write-Host "  Process Name: $($ga4Process.ProcessName)" -ForegroundColor Cyan
    Write-Host "  Process ID: $($ga4Process.Id)" -ForegroundColor Cyan
    Write-Host "  Responding: $($ga4Process.Responding)" -ForegroundColor $(if($ga4Process.Responding){"Green"}else{"Red"})
    Write-Host "  Memory (MB): $([math]::Round($ga4Process.WorkingSet64 / 1MB, 2))" -ForegroundColor Cyan
    Write-Host "  Threads: $($ga4Process.Threads.Count)" -ForegroundColor Cyan

    if (-not $ga4Process.Responding) {
        Write-Host "  ✗ GA4 is NOT RESPONDING - this explains flakiness!" -ForegroundColor Red
    } else {
        Write-Host "  ✓ GA4 is healthy and responding" -ForegroundColor Green
    }
} else {
    Write-Host "  ✗ GA4 process not found!" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== DIAGNOSTIC COMPLETE ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "FLAKINESS SOURCES TO CHECK:" -ForegroundColor Yellow
Write-Host "  1. Focus lost during operations? (Test 1)" -ForegroundColor Gray
Write-Host "  2. Clipboard write/read failures? (Test 2)" -ForegroundColor Gray
Write-Host "  3. Slow click execution? (Test 3)" -ForegroundColor Gray
Write-Host "  4. Resolution mismatch? (Test 4)" -ForegroundColor Gray
Write-Host "  5. Process not responding? (Test 5)" -ForegroundColor Gray

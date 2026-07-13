# Simple GA4 Diagnostic Test
Write-Host "=== GA4 DIAGNOSTIC TEST ===" -ForegroundColor Cyan
Write-Host ""

# Test 1: Find GA4 Window
Write-Host "[1] Searching for GA4 window..." -ForegroundColor Yellow
$processes = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" }
if ($processes) {
    foreach ($p in $processes) {
        Write-Host "  Found: $($p.ProcessName) - '$($p.MainWindowTitle)'" -ForegroundColor Green
        Write-Host "    Process ID: $($p.Id)"
        Write-Host "    Responding: $($p.Responding)"
    }
} else {
    Write-Host "  No GA4 window found!" -ForegroundColor Red
}
Write-Host ""

# Test 2: Clipboard Test
Write-Host "[2] Testing clipboard..." -ForegroundColor Yellow
try {
    Add-Type -AssemblyName System.Windows.Forms
    $timestamp = Get-Date -Format "HHmmss"
    $testValue = "TEST_$timestamp"

    [System.Windows.Forms.Clipboard]::SetText($testValue)
    Start-Sleep -Milliseconds 200
    $readValue = [System.Windows.Forms.Clipboard]::GetText()

    if ($readValue -eq $testValue) {
        Write-Host "  Clipboard works: wrote and read '$testValue'" -ForegroundColor Green
    } else {
        Write-Host "  Clipboard FAILED: wrote '$testValue', got '$readValue'" -ForegroundColor Red
    }
} catch {
    Write-Host "  Clipboard error: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

# Test 3: Screen Info
Write-Host "[3] Screen information..." -ForegroundColor Yellow
try {
    Add-Type -AssemblyName System.Windows.Forms
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    Write-Host "  Resolution: $($screen.Bounds.Width) x $($screen.Bounds.Height)" -ForegroundColor Green
    Write-Host "  Working area: $($screen.WorkingArea.Width) x $($screen.WorkingArea.Height)" -ForegroundColor Green
} catch {
    Write-Host "  Screen info error: $($_.Exception.Message)" -ForegroundColor Red
}
Write-Host ""

Write-Host "=== TEST COMPLETE ===" -ForegroundColor Cyan

# Quick Flakiness Diagnostic
param(
    [int]$TestCount = 5
)

Write-Host "GA4 FLAKINESS DIAGNOSTIC" -ForegroundColor Cyan
Write-Host ""

# Test: Window Focus
Write-Host "[1] Window Focus Check" -ForegroundColor Yellow
$ga4 = Get-Process | Where-Object { $_.MainWindowTitle -like "*Garage Assistant*" } | Select-Object -First 1
if ($ga4) {
    Write-Host "  Found: $($ga4.MainWindowTitle)" -ForegroundColor Green
    Write-Host "  Responding: $($ga4.Responding)" -ForegroundColor $(if($ga4.Responding){"Green"}else{"Red"})
} else {
    Write-Host "  ERROR: GA4 not found!" -ForegroundColor Red
}
Write-Host ""

# Test: Clipboard Reliability
Write-Host "[2] Clipboard Test - $TestCount iterations" -ForegroundColor Yellow
Add-Type -AssemblyName System.Windows.Forms

$failures = 0
$times = @()

for ($i = 1; $i -le $TestCount; $i++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $testValue = "CLIP_TEST_$i"

    [Windows.Forms.Clipboard]::SetText($testValue)
    Start-Sleep -Milliseconds 50
    $readValue = [Windows.Forms.Clipboard]::GetText()

    $sw.Stop()
    $times += $sw.ElapsedMilliseconds

    if ($readValue -ne $testValue) {
        $failures++
        Write-Host "  FAIL $i wrote $testValue got $readValue" -ForegroundColor Red
    }
}

$avgTime = ($times | Measure-Object -Average).Average
Write-Host "  Failures: $failures / $TestCount" -ForegroundColor $(if($failures -eq 0){"Green"}else{"Red"})
Write-Host "  Avg Time: $([math]::Round($avgTime, 1))ms" -ForegroundColor Cyan
Write-Host ""

# Test: Click Performance
Write-Host "[3] Click Performance Test" -ForegroundColor Yellow
$clickTimes = @()

for ($i = 1; $i -le 3; $i++) {
    $sw = [Diagnostics.Stopwatch]::StartNew()

    # Simple mouse event
    Add-Type -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool SetCursorPos(int x, int y);
"@ -Name "MouseAPI" -Namespace "Win32" -PassThru | Out-Null

    [Win32.MouseAPI]::SetCursorPos(100 + $i, 100 + $i) | Out-Null

    $sw.Stop()
    $clickTimes += $sw.ElapsedMilliseconds
}

$avgClick = ($clickTimes | Measure-Object -Average).Average
Write-Host "  Avg mouse operation: $([math]::Round($avgClick, 1))ms" -ForegroundColor Cyan
Write-Host ""

# Test: Screen Resolution
Write-Host "[4] Screen Resolution" -ForegroundColor Yellow
$screen = [Windows.Forms.Screen]::PrimaryScreen
Write-Host "  Resolution: $($screen.Bounds.Width) x $($screen.Bounds.Height)" -ForegroundColor Cyan
Write-Host "  Expected: ~1514 x 1191" -ForegroundColor Gray

$widthMatch = [math]::Abs($screen.Bounds.Width - 1514) -lt 10
$heightMatch = [math]::Abs($screen.Bounds.Height - 1191) -lt 10

if ($widthMatch -and $heightMatch) {
    Write-Host "  Status: MATCHES" -ForegroundColor Green
} else {
    Write-Host "  Status: MISMATCH - coordinate mapping affected" -ForegroundColor Red
}
Write-Host ""

Write-Host "DIAGNOSTIC COMPLETE" -ForegroundColor Cyan

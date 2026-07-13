# GA4 Coordinate Calibration Tool
# Finds correct coordinates for key UI elements

param(
    [switch]$Interactive = $false
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Write-Host "=== GA4 COORDINATE CALIBRATION ===" -ForegroundColor Cyan
Write-Host ""

# Helper: Take screenshot
function Take-Screenshot {
    param([string]$Name = "calibration")

    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)

    $path = "C:\Users\ELI MOTOTRS LTD\calibration-$Name.png"
    $bitmap.Save($path)

    $graphics.Dispose()
    $bitmap.Dispose()

    return $path
}

# Helper: Click at coordinates
function Test-Click {
    param([int]$X, [int]$Y, [string]$TargetName)

    Write-Host "  Testing: $TargetName at ($X, $Y)..." -ForegroundColor Yellow

    # Take before screenshot
    $before = Take-Screenshot "before-$($TargetName -replace ' ','-')"

    # Execute click
    $clickScript = Get-Content "C:\Users\ELI MOTOTRS LTD\GA4Scanner\scripts\click.ps1" -Raw
    $scriptBlock = [scriptblock]::Create($clickScript)
    & $scriptBlock $X $Y | Out-Null

    Start-Sleep -Milliseconds 500

    # Take after screenshot
    $after = Take-Screenshot "after-$($TargetName -replace ' ','-')"

    Write-Host "    Before: $before" -ForegroundColor Gray
    Write-Host "    After:  $after" -ForegroundColor Gray

    return @{
        Target = $TargetName
        X = $X
        Y = $Y
        BeforeImage = $before
        AfterImage = $after
    }
}

# Calibration points - key UI elements in GA4
$calibrationPoints = @(
    @{ Name = "Parts Tab"; X = 652; Y = 627; Expected = "Parts tab becomes active" },
    @{ Name = "Labour Tab"; X = 471; Y = 627; Expected = "Labour tab becomes active" },
    @{ Name = "Description Tab"; X = 291; Y = 627; Expected = "Description tab becomes active" },
    @{ Name = "History Tab"; X = 110; Y = 627; Expected = "History tab becomes active" }
)

Write-Host "This tool will test $($calibrationPoints.Count) calibration points" -ForegroundColor Cyan
Write-Host "Each test will:" -ForegroundColor Gray
Write-Host "  1. Take a 'before' screenshot" -ForegroundColor Gray
Write-Host "  2. Click the target" -ForegroundColor Gray
Write-Host "  3. Take an 'after' screenshot" -ForegroundColor Gray
Write-Host "  4. You verify if it worked" -ForegroundColor Gray
Write-Host ""

$results = @()

# Test each calibration point
foreach ($point in $calibrationPoints) {
    $result = Test-Click -X $point.X -Y $point.Y -TargetName $point.Name
    $result.Expected = $point.Expected
    $results += $result

    if ($Interactive) {
        Write-Host ""
        Write-Host "  Expected: $($point.Expected)" -ForegroundColor Cyan
        $response = Read-Host "  Did it work? (y/n/skip)"
        $result.Success = ($response -eq 'y')
        $result.UserFeedback = $response

        if ($response -eq 'skip') { break }
    }

    Write-Host ""
    Start-Sleep -Milliseconds 300
}

# Save calibration report
$reportPath = "C:\Users\ELI MOTOTRS LTD\calibration-report.json"
$results | ConvertTo-Json -Depth 3 | Set-Content $reportPath

Write-Host "=== CALIBRATION COMPLETE ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Results saved to: $reportPath" -ForegroundColor Green
Write-Host "Screenshots saved to: C:\Users\ELI MOTOTRS LTD\calibration-*.png" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Review the before/after screenshots" -ForegroundColor Gray
Write-Host "  2. Identify which clicks worked vs failed" -ForegroundColor Gray
Write-Host "  3. Measure the offset for failed clicks" -ForegroundColor Gray
Write-Host "  4. Update coordinate mapping formula" -ForegroundColor Gray
Write-Host ""

# Display summary
Write-Host "CALIBRATION SUMMARY:" -ForegroundColor Cyan
foreach ($r in $results) {
    $status = if ($r.Success -eq $true) { "PASS" } elseif ($r.Success -eq $false) { "FAIL" } else { "UNKNOWN" }
    $color = if ($r.Success -eq $true) { "Green" } elseif ($r.Success -eq $false) { "Red" } else { "Yellow" }
    Write-Host "  [$status] $($r.Target) at ($($r.X), $($r.Y))" -ForegroundColor $color
}

# Find Clickable Area - Grid Search
# Tests a grid of coordinates to find where clicks actually register

param(
    [int]$CenterX = 652,  # Parts tab approximate X
    [int]$CenterY = 627,  # Approximate Y
    [int]$Range = 30,     # Test +/- 30 pixels
    [int]$Step = 10       # Test every 10 pixels
)

Write-Host "=== FINDING CLICKABLE AREA ===" -ForegroundColor Cyan
Write-Host "Testing grid around ($CenterX, $CenterY)" -ForegroundColor Gray
Write-Host "Range: +/- $Range pixels, Step: $Step pixels" -ForegroundColor Gray
Write-Host ""

# Load click script
$clickScript = Get-Content "C:\Users\ELI MOTOTRS LTD\GA4Scanner\scripts\click.ps1" -Raw

# Take baseline screenshot
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Take-Screenshot {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)

    $path = "C:\Users\ELI MOTOTRS LTD\grid-search-temp.png"
    $bitmap.Save($path)

    $graphics.Dispose()
    $bitmap.Dispose()

    return $path
}

Write-Host "Baseline: Currently on History tab" -ForegroundColor Yellow
Write-Host "Goal: Find coordinates that switch to Parts tab" -ForegroundColor Yellow
Write-Host ""

$testPoints = @()

# Generate test grid (Y axis variations)
for ($yOffset = -$Range; $yOffset -le $Range; $yOffset += $Step) {
    $testY = $CenterY + $yOffset

    Write-Host "Testing Y = $testY (offset: $yOffset)..." -ForegroundColor Cyan

    # Click at this Y coordinate
    $scriptBlock = [scriptblock]::Create($clickScript)
    & $scriptBlock $CenterX $testY | Out-Null

    Start-Sleep -Milliseconds 400

    # Take screenshot to check result
    $screenshot = Take-Screenshot

    # Simple check: Ask user if Parts tab is now active
    Write-Host "  Clicked at ($CenterX, $testY)" -ForegroundColor Gray
    Write-Host "  Screenshot: $screenshot" -ForegroundColor Gray

    $testPoints += @{
        X = $CenterX
        Y = $testY
        YOffset = $yOffset
    }

    # Small delay between tests
    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "=== GRID SEARCH COMPLETE ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Tested $($testPoints.Count) Y coordinates:" -ForegroundColor Yellow
foreach ($point in $testPoints) {
    Write-Host "  Y = $($point.Y) (offset: $($point.YOffset))" -ForegroundColor Gray
}
Write-Host ""
Write-Host "Check final screenshot to see what tab is active." -ForegroundColor Cyan
Write-Host ""

# Take final screenshot
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\ELI MOTOTRS LTD\screenshot.ps1"

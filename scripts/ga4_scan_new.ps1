# ga4_scan_new.ps1 - find GA4 invoices the web app does not know about.
#
#   ga4_scan_new.ps1 -From 90826            # probe forward from the last known number
#   ga4_scan_new.ps1 -From 90826 -Json out.json
#
# WHY IT WORKS THIS WAY: GA4's list views are custom-drawn by FileMaker and are NOT in the
# UI Automation tree - findtext against a visible list row returns NO_HIT, so the list
# cannot be scraped as text. Open RECORDS however are fully readable via UIA.
#
# So instead of reading the list, we exploit the numbering invariant: GA4 mints numbers as
# max+1 and never reuses them, so the sequence has no holes. Walk forward from the highest
# number we already know, ask GA4 for each one in turn, and stop after a few consecutive
# misses. That is guaranteed to find every new document without parsing a single pixel.
#
# SCOPE: this reports WHICH invoices are missing and their headline totals - enough to
# detect drift the moment it happens. It does not read line items; portals are not reliably
# exposed either, so importing the detail still needs a pass over the Labour/Parts tabs.
param(
  [Parameter(Mandatory=$true)][int]$From,
  [int]$MaxMisses = 3,
  [int]$Limit = 40,
  [string]$Json,
  [int]$IdleSeconds = 120
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$GA4  = Join-Path $here "ga4.ps1"
$UIA  = Join-Path $here "ga4_uia.ps1"
$SRCH = Join-Path $here "ga4_search.ps1"
$PS   = "powershell.exe"
function Ga4($a) { & $PS -NoProfile -ExecutionPolicy Bypass -File $GA4 @a | Out-Null }
function Uia($a) { return (& $PS -NoProfile -ExecutionPolicy Bypass -File $UIA @a) }

# Read-only, but still refuse to run while somebody is working: taking focus mid-keystroke
# is disruptive even when we only look.
$dataFile = "C:\Program Files (x86)\Garage Assistant GA4\GA4_UserData.GA4"
if (Test-Path $dataFile) {
  $idle = (New-TimeSpan -Start (Get-Item $dataFile).LastWriteTime -End (Get-Date)).TotalSeconds
  if ($idle -lt $IdleSeconds) {
    Write-Host "ABORT: GA4 written to $([int]$idle)s ago - somebody is using it." -ForegroundColor Red
    exit 1
  }
}

$found = @()
$misses = 0
$n = $From + 1

while ($misses -lt $MaxMisses -and ($n - $From) -le $Limit) {
  & $PS -NoProfile -ExecutionPolicy Bypass -File $SRCH "$n" | Out-Null
  Start-Sleep -Milliseconds 1500
  Ga4 @("click","1491","797")          # open the first search result
  # GA4 takes a couple of seconds to open a record. Reading the header too early returns
  # nothing and the number is wrongly reported as missing - which is far worse than being
  # slow, because a false "not found" hides real drift.
  Start-Sleep -Milliseconds 3000

  $h = "$(Uia @('header'))"
  if ($h -match 'num=(\d+) state=(\w+)' -and $Matches[1] -eq "$n") {
    $state = $Matches[2]
    $reg = ""
    $r = "$(Uia @('get','vehRegistration'))"
    if ($r -match 'value=(.+)$') { $reg = $Matches[1].Trim() }
    $total = $null
    foreach ($x in 3155,3120,3090,3060) {
      $t = "$(Uia @('readpt',"$x","1957"))"
      if ($t -match "readpt=([\d,]+\.\d\d)") { $total = $Matches[1] -replace ',',''; break }
    }
    $found += [pscustomobject]@{ ga4Number = "$n"; state = $state; registration = $reg; total = $total }
    Write-Host ("  {0}  {1,-12} {2,10}  {3}" -f $n, $reg, $total, $state) -ForegroundColor Green
    $misses = 0
  } else {
    $misses++
    Write-Host ("  {0}  - not found ({1}/{2} misses)" -f $n, $misses, $MaxMisses) -ForegroundColor DarkGray
  }
  Ga4 @("click","2858","152")          # close whatever opened, back to a known state
  Start-Sleep -Milliseconds 800
  $n++
}

Write-Host ""
Write-Host "Found $($found.Count) GA4 document(s) above $From" -ForegroundColor Cyan
$issued = @($found | Where-Object { $_.state -eq 'Issued' })
Write-Host "  of which issued: $($issued.Count)  (the rest are unfilled blanks)" -ForegroundColor Cyan
if ($issued.Count -gt 0) {
  Write-Host ""
  Write-Host "Cross-check against the web app with:"
  # Only issued documents are checked. An unfilled blank legitimately has no web row, so
  # including them would report a 'missing' invoice on every single run and train everyone
  # to ignore the output.
  $list = ($issued | ForEach-Object { "('" + $_.ga4Number + "')" }) -join ","
  Write-Output @"
SELECT v.n AS ga4_number,
       CASE WHEN h.id IS NULL THEN 'MISSING FROM WEBAPP' ELSE 'present (' || h."totalGross" || ')' END AS status
FROM (VALUES $list) AS v(n)
LEFT JOIN "serviceHistory" h ON h."ga4Number" = v.n AND h."docType" = 'SI'
ORDER BY v.n;
"@
}
if ($Json) { $found | ConvertTo-Json -Depth 3 | Set-Content -Path $Json -Encoding utf8; Write-Host "`nJSON written to $Json" }

# ga4_replenish.ps1 - create N blank invoices in GA4 and report the numbers GA4 assigned.
#
#   ga4_replenish.ps1 -Count 10            # create 10 blanks (asks first)
#   ga4_replenish.ps1 -Count 10 -Force     # no prompt (for scheduled use)
#   ga4_replenish.ps1 -DryRun              # check preconditions and coords only, create nothing
#
# Prints the created numbers AND ready-to-run SQL to register them in ga4NumberPool +
# ga4NumberLedger. It deliberately does NOT touch the database itself: a blank that exists
# in GA4 but not in the pool is harmless, whereas a pool row with no GA4 blank behind it
# hands the web app a number that does not exist. Fail in the safe direction.
#
# WHY THIS EXISTS: on 2026-07-21 the pool emptied at 09:47 and the web app responded by
# inventing its own numbers (90863, 90864) that GA4 had never issued and would later reuse
# for different customers. Keeping the pool stocked is the primary defence against that.
param(
  [int]$Count = 10,
  [switch]$Force,
  [switch]$DryRun,
  # Coordinates are physical px in the GA4 window. VERIFY THESE ON FIRST RUN with -DryRun:
  # GA4's layout shifts if the window is not maximised.
  [int]$NewInvoiceX = 153, [int]$NewInvoiceY = 345,
  [int]$CloseX = 2858,     [int]$CloseY = 152,
  [int]$IdleSeconds = 120
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$GA4  = Join-Path $here "ga4.ps1"
$UIA  = Join-Path $here "ga4_uia.ps1"
$PS   = "powershell.exe"
function Ga4($a) { & $PS -NoProfile -ExecutionPolicy Bypass -File $GA4 @a | Out-Null }
function Uia($a) { return (& $PS -NoProfile -ExecutionPolicy Bypass -File $UIA @a) }

# ---- Precondition: GA4 must be IDLE ---------------------------------------------------
# GA4 is a shared, single-user app. Driving it while somebody is working corrupts their
# record - that is exactly how job sheet 93232 got the wrong customer attached. The data
# file's mtime is a reliable activity signal and costs nothing to read.
$dataFile = "C:\Program Files (x86)\Garage Assistant GA4\GA4_UserData.GA4"
if (Test-Path $dataFile) {
  $idle = (New-TimeSpan -Start (Get-Item $dataFile).LastWriteTime -End (Get-Date)).TotalSeconds
  Write-Host ("GA4 data file last written {0:N0}s ago" -f $idle)
  if ($idle -lt $IdleSeconds) {
    Write-Host "ABORT: GA4 was written to $([int]$idle)s ago - somebody is probably using it." -ForegroundColor Red
    Write-Host "       Re-run when it has been quiet for $IdleSeconds seconds." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "WARNING: could not find GA4 data file to check idleness" -ForegroundColor Yellow
}

if ($DryRun) {
  Ga4 @("shot", "$env:TEMP\ga4_replenish_dryrun.png")
  Write-Host "-DryRun: GA4 is idle. Screenshot at $env:TEMP\ga4_replenish_dryrun.png"
  Write-Host "Verify 'New Invoice' really is at ($NewInvoiceX,$NewInvoiceY) before running for real."
  exit 0
}

if (-not $Force) {
  Write-Host "About to create $Count blank invoices in GA4." -ForegroundColor Cyan
  Write-Host "Each one permanently consumes a GA4 number - they are never reusable." -ForegroundColor Yellow
  $ans = Read-Host "Type YES to continue"
  if ($ans -ne "YES") { Write-Host "Cancelled."; exit 0 }
}

# ---- Create the blanks ----------------------------------------------------------------
$created = @()
for ($i = 1; $i -le $Count; $i++) {
  Ga4 @("click", "$NewInvoiceX", "$NewInvoiceY")
  Start-Sleep -Milliseconds 1800

  # Read back the number GA4 assigned. This is the whole point of doing it one at a time:
  # we never guess what number was created, we read it from the record's own header.
  $h = "$(Uia @('header'))"
  if ($h -match 'num=(\d+) state=(\w+)') {
    $num = $Matches[1]
    if ($created -contains $num) {
      Write-Host "ABORT: header still reads $num - the New Invoice click did not land." -ForegroundColor Red
      Ga4 @("shot", "$env:TEMP\ga4_replenish_fail.png")
      break
    }
    $created += $num
    Write-Host ("  created blank {0} ({1}/{2})" -f $num, $i, $Count) -ForegroundColor Green
  } else {
    Write-Host "ABORT: no invoice header after New Invoice - stopping rather than clicking blind." -ForegroundColor Red
    Ga4 @("shot", "$env:TEMP\ga4_replenish_fail.png")
    break
  }

  Ga4 @("click", "$CloseX", "$CloseY")   # close the record, back to the list
  Start-Sleep -Milliseconds 1200
}

if ($created.Count -eq 0) { Write-Host "No blanks created." -ForegroundColor Red; exit 1 }

# ---- Emit registration SQL ------------------------------------------------------------
Write-Host ""
Write-Host "Created $($created.Count) blank(s): $($created -join ', ')" -ForegroundColor Cyan
Write-Host ""
Write-Host "Run this to register them (pool = claimable by the web app, ledger = number consumed):"
Write-Host ""
$today = Get-Date -Format "yyyy-MM-dd"
$vals  = ($created | ForEach-Object { "  ('$_','available',0,'Pool replenish ${today}: GA4 blank created and header-verified', now(), now())" }) -join ",`n"
$lvals = ($created | ForEach-Object { "  ('$_','blank',NULL,'GA4 blank created $today by ga4_replenish.ps1')" }) -join ",`n"
Write-Output @"
INSERT INTO "ga4NumberLedger" ("ga4Number","state","documentId","note") VALUES
$lvals
ON CONFLICT ("ga4Number") DO NOTHING;

INSERT INTO "ga4NumberPool" ("ga4Number","status","attempts","note","createdAt","updatedAt") VALUES
$vals
ON CONFLICT DO NOTHING;
"@

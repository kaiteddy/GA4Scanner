# ga4_fill.ps1 - one-command GA4 invoice fill from a web work-order, with a programmatic
# total guard. Consolidates the manual recipe proven 2026-07-20 (5 invoices, exact totals).
#
#   ga4_fill.ps1 <workorder.json>            # fill + verify total, STOP before issue (safe default)
#   ga4_fill.ps1 <workorder.json> -Issue     # ...then issue too (handles reminder/payment dialogs)
#   ga4_fill.ps1 <workorder.json> -DryRun    # open + guard identity only, no writes
#
# Work-order JSON (generate from Neon serviceHistory + serviceLineItems):
# {
#   "poolNumber":"90803",              // the reserved GA4 blank to fill (also the identity guard)
#   "webDocId":420609,                 // reference only
#   "registration":"LP18 CXZ",
#   "mileage":76530,
#   "labour":[{"desc":"Mechanical Labour","qty":1,"price":20},{"desc":"Adjust Headlights","qty":1,"price":12}],
#   "parts":[{"desc":"Tyre","qty":2,"price":67}],
#   "mot":true,                        // true => Full / TYPE A - RETAIL / Pass; false/omit => none
#   "sundries":4.50,                   // 0/omit => none
#   "description":"Carry out MOT\n...",
#   "expectTotal":83.40                // REQUIRED - abort if GA4's computed total != this to the penny
# }
#
# Reuses sibling scripts ga4.ps1 (cell/click/key/shot) + ga4_uia.ps1 (fill/setmenu/readpt) so every
# action re-focuses GA4 (no cross-process focus drift). Physical-px coords; GA4 window ~(-4,-4).
param(
  [Parameter(Mandatory=$true)][string]$Wo,
  [switch]$Issue,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$GA4  = Join-Path $here "ga4.ps1"
$UIA  = Join-Path $here "ga4_uia.ps1"
$SRCH = Join-Path $here "ga4_search.ps1"

if (-not (Test-Path $Wo)) { throw "work-order not found: $Wo" }
$j = Get-Content $Wo -Raw | ConvertFrom-Json
foreach ($f in @("poolNumber","registration","expectTotal")) {
  if ($null -eq $j.$f -or "$($j.$f)" -eq "") { throw "work-order missing required field: $f (script refuses to arm)" }
}
$expect = [decimal]$j.expectTotal
$reg    = "$($j.registration)"

# Invoke each primitive as its OWN powershell process (as proven manually): re-focuses GA4 each
# call AND avoids Add-Type "type already exists" collisions from re-running the helpers in-process.
$PS = "powershell.exe"
function Ga4($a)  { & $PS -NoProfile -ExecutionPolicy Bypass -File $GA4 @a | Out-Null }
function Uia($a)  { return (& $PS -NoProfile -ExecutionPolicy Bypass -File $UIA @a) }
function Shot()   { & $PS -NoProfile -ExecutionPolicy Bypass -File $GA4 shot | Out-Null }
# Absolute-screen DPI-aware click (for custom-drawn popup items that clear the window title).
Add-Type @"
using System;using System.Runtime.InteropServices;
public class AC { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e); }
"@ 2>$null
[AC]::SetProcessDPIAware() | Out-Null
function AbsClick($x,$y){ [AC]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 200
  [AC]::mouse_event(0x2,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 70
  [AC]::mouse_event(0x4,0,0,0,[IntPtr]::Zero); Start-Sleep -Milliseconds 600 }
# Read the invoice grand total from the Totals panel (Text element, no ValuePattern). Sample a few
# x-offsets near the right-aligned value and take the first that parses as money.
function ReadTotal(){
  foreach($x in 3155,3120,3090,3060){
    $r = Uia @("readpt","$x","1957")
    if("$r" -match "readpt=([\d,]+\.\d\d)"){ return [decimal]($Matches[1] -replace ',','') }
  }
  return $null
}
function Fail($m){ Write-Host "ABORT: $m" -ForegroundColor Red; exit 1 }

Write-Host "== ga4_fill $($j.poolNumber) $reg expect=GBP $expect ==" -ForegroundColor Cyan

# ---- 1) Open the reserved blank, GUARD by EXACT invoice number (the whole point: GA4 number MUST
#         equal the web number). A bare-number Quick Search is timing/collision-flaky, so we read the
#         header ("Invoice: <n>  (Not Issued)") and only proceed when <n> == poolNumber; else retry. --
function RegOf($s){ if ("$s" -match "value=(.+)$"){ return $Matches[1].Trim() } else { return "" } }
function Header(){ $h = "$(Uia @("header"))"; if ($h -match "num=(\d+) state=(\w+)"){ return @{ num=$Matches[1]; state=$Matches[2] } } else { return $null } }
$want = "$($j.poolNumber)"
$opened = $false
for ($try=1; $try -le 4; $try++) {
  & $PS -NoProfile -ExecutionPolicy Bypass -File $SRCH $want | Out-Null; Start-Sleep -Milliseconds 1200
  Ga4 @("click","1491","797"); Start-Sleep -Milliseconds 1000     # open the search result (or a list row)
  $hd = Header
  if ($hd -and $hd.num -eq $want -and $hd.state -eq "NotIssued") {
    $rv = RegOf (Uia @("get","vehRegistration"))
    if ($rv -ne "" -and $rv -ne "Required") { Fail "invoice $want already has reg='$rv' - not an empty blank, refusing to write" }
    $t0 = ReadTotal
    if ($null -ne $t0 -and $t0 -ne 0) { Fail "invoice $want total is GBP $t0, not empty - refusing to write" }
    $opened = $true; break
  }
  $seen = if ($hd) { "invoice $($hd.num)/$($hd.state)" } else { "no invoice header (list view / wrong click)" }
  Write-Host "  open attempt $try -> $seen (want $want / NotIssued) - closing + retrying" -ForegroundColor DarkYellow
  Ga4 @("click","2858","152"); Start-Sleep -Milliseconds 900       # close record, retry the search
}
if (-not $opened) { Fail "could not open BLANK invoice $want (exact number, Not Issued) after 4 tries - open it manually and re-run" }
Write-Host "  identity OK: EXACT invoice $want, Not Issued, empty" -ForegroundColor Green
if ($DryRun) { Write-Host "  -DryRun: number-match guard passed, no writes."; exit 0 }

# ---- 2) Registration (two-step commit fires vehicle+customer lookup) -------------------------
$regNoSpace = $reg -replace '\s',''
Ga4 @("cell","416","279","$regNoSpace"); Start-Sleep -Milliseconds 1000
Ga4 @("cell","416","279","$regNoSpace"); Start-Sleep -Milliseconds 1500
Shot   # capture - an "Open Document Exists" warning may appear; dismiss with Ignore
# (If present, Ignore is at ~2022,1273. Harmless click if absent lands in the list.)
Ga4 @("click","2022","1273"); Start-Sleep -Milliseconds 500
# GUARD: the reg lookup must have attached the RIGHT vehicle (reg field now == work-order reg)
$rvNow = RegOf (Uia @("get","vehRegistration"))
if (($rvNow -replace '\s','') -ne $regNoSpace) {
  Fail "after reg entry the invoice reg='$rvNow' != work-order '$reg' - aborting (wrong vehicle); invoice left unissued"
}
Write-Host "  vehicle OK: $rvNow"

# ---- 3) Mileage -----------------------------------------------------------------------------
if ($j.mileage) { Ga4 @("cell","362","604","$($j.mileage)") }

# ---- 4) Labour lines --------------------------------------------------------------------------
# Columns are Desc | Tech | Qty | Unit Price. Two traps, both verified live on 90808 (2026-07-21):
#   1. Committing the Description opens the Tech pop-up menu, which covers the Qty/Price cells.
#      Any click aimed at them lands on the menu instead, so the value never arrives. Escape it
#      after EVERY cell commit and the next click lands cleanly.
#   2. `gridrow` (Desc,Tab,Tab=Qty,Tab=Price) is WRONG for a fresh, empty portal row: GA4 creates
#      the row on commit and returns focus to Description, so the qty overwrites the description
#      and the price is lost. It produced a row literally described "0.5" with no price.
# Per-cell clicks + Escape are what actually work. Keep them.
if ($j.labour) {
  Ga4 @("click","580","770"); Start-Sleep -Milliseconds 700
  $i = 0
  foreach ($l in $j.labour) {
    $y = 889 + ($i * 50)
    Ga4 @("cell","680","$y","$($l.desc)");   Ga4 @("key","1B")
    Ga4 @("cell","2317","$y","$($l.qty)");   Ga4 @("key","1B")
    Ga4 @("cell","2426","$y","$($l.price)"); Ga4 @("key","1B")
    $i++
  }
}

# ---- 5) Parts lines (free-text descriptions commit cleanly) ----------------------------------
if ($j.parts) {
  Ga4 @("click","801","770"); Start-Sleep -Milliseconds 700
  $i = 0
  foreach ($p in $j.parts) {
    $y = 889 + ($i * 50)
    Ga4 @("cell","510","$y","$($p.desc)")
    Ga4 @("cell","2315","$y","$($p.qty)")
    Ga4 @("cell","2424","$y","$($p.price)")
    $i++
  }
}

# ---- 6) MOT (Full / TYPE A - RETAIL / Pass; tester auto-fills DB) -----------------------------
if ($j.mot) {
  Ga4 @("click","3210","1459"); Start-Sleep -Milliseconds 900; AbsClick 3138 1470   # Full
  Ga4 @("click","3290","1499"); Start-Sleep -Milliseconds 900; AbsClick 3155 1484   # TYPE A - RETAIL
  Ga4 @("click","3290","1535"); Start-Sleep -Milliseconds 900; AbsClick 3141 1523   # Pass
}

# ---- 7) Sundries -----------------------------------------------------------------------------
if ($j.sundries -and [decimal]$j.sundries -gt 0) {
  Ga4 @("cell","3205","1631","$($j.sundries)")
  Ga4 @("key","1B")
}

# ---- 8) Description narrative ----------------------------------------------------------------
if ($j.description) {
  Ga4 @("click","355","770"); Start-Sleep -Milliseconds 700
  Ga4 @("click","1445","1200")
  Add-Type -AssemblyName System.Windows.Forms
  $txt = ($j.description -replace "`r","")
  $sk = ($txt -replace '([+^%~(){}])','{$1}') -replace "`n","{ENTER}"
  [System.Windows.Forms.SendKeys]::SendWait($sk)
  Start-Sleep -Milliseconds 500
}

# ---- 9) GUARD: still the exact invoice (shared session may have drifted), and total to the penny --
Shot
$hd2 = Header
if (-not $hd2 -or $hd2.num -ne $want) { Fail "before-issue check: open invoice is '$(if($hd2){$hd2.num}else{'?'})' not $want (session drifted?) - NOT issuing" }
if ($hd2.state -ne "NotIssued") { Fail "invoice $want is already $($hd2.state) - NOT re-issuing" }
$got = ReadTotal
if ($null -eq $got) { Fail "could not read GA4 total for verification" }
Write-Host ("  total check: GA4=GBP {0}  expect=GBP {1}" -f $got,$expect)
if ([Math]::Abs($got - $expect) -ge 0.01) {
  Fail "TOTAL MISMATCH (GA4 GBP $got vs expected GBP $expect) - invoice left as an unissued draft, NOT issued"
}
Write-Host "   total matches to the penny" -ForegroundColor Green

if (-not $Issue) {
  Write-Host "FILLED + VERIFIED (not issued). Review, then re-run with -Issue to issue." -ForegroundColor Yellow
  exit 0
}

# ---- 10) ISSUE - dialog chain varies (MOT/Service reminder, then payments). Best-effort:
#     click Issue, then Yes(Auto) for any reminder dialog, then Issue Only. Screenshot each step.
#     NOTE: needs a supervised first run - verify the dialog buttons match before trusting unattended.
Write-Host "  issuing..." -ForegroundColor Cyan
Ga4 @("click","377","207"); Start-Sleep -Milliseconds 1500; Shot   # reminder dialog may appear
AbsClick 1817 1220; Start-Sleep -Milliseconds 1500; Shot           # Yes(Auto) if reminder present
AbsClick 1817 1220; Start-Sleep -Milliseconds 1500; Shot           # 2nd reminder (MOT+Service) if present
AbsClick 2056 724;  Start-Sleep -Milliseconds 1500; Shot           # Issue Only on the payments dialog
Write-Host "  issue sequence sent - VERIFY via screenshot that $($j.poolNumber) shows (Issued) and the totals stuck." -ForegroundColor Yellow
Write-Host ('  then mark pool filled:  UPDATE "ga4NumberPool" SET status=''filled'', "filledAt"=now() WHERE "ga4Number"=''{0}'';' -f $j.poolNumber)

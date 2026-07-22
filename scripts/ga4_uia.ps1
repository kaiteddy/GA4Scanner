# GA4 UI-Automation driver (no pixels, no popups-by-image).
# Commands:
#   ga4_uia.ps1 get     <fieldAid>              read an Edit field's value
#   ga4_uia.ps1 setval  <fieldAid> <text>       set an Edit field via ValuePattern (NO COMMIT - often ignored by FileMaker)
#   ga4_uia.ps1 fill    <fieldAid> <text>       PREFERRED text entry: SetFocus+select-all+type+Tab (COMMITS, fires triggers)
#   ga4_uia.ps1 setmenu <fieldAid> <option>     set a FileMaker pop-up menu field (SetFocus + type-ahead + Enter)
#   ga4_uia.ps1 button  <name>                  invoke a toolbar button by name
# fieldAid may be given WITHOUT the "Field: Docs::" prefix (it's added if missing).
# Field control-type cheat sheet (this GA4 build):
#   Edit  fields -> use setval  (ValuePattern)      e.g. vehMileage, custAddress_*, docOrderRef
#   Menu  fields -> use setmenu (focus+type-ahead)  e.g. motStatus, motClass, motType, staffMOTTester
#   Buttons      -> use button  (InvokePattern)     e.g. Save, Issue, Convert, Draft, Delete
param([string]$Cmd, [string]$A1, [string]$A2)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WU {
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr FindFMPRO(){ IntPtr h=IntPtr.Zero;
    while((h=FindWindowEx(IntPtr.Zero,h,null,null))!=IntPtr.Zero){ StringBuilder sb=new StringBuilder(256);
      GetClassName(h,sb,256); if(sb.ToString().ToUpper().Contains("FMPRO")) return h; } return IntPtr.Zero; }
}
"@
$AE=[System.Windows.Automation.AutomationElement]
$TS=[System.Windows.Automation.TreeScope]
$P_Val=[System.Windows.Automation.ValuePattern]::Pattern
$P_Inv=[System.Windows.Automation.InvokePattern]::Pattern
$P_Sel=[System.Windows.Automation.SelectionItemPattern]::Pattern

[WU]::SetProcessDPIAware() | Out-Null   # so AutomationElement.FromPoint uses physical px (matches ga4.ps1)
$hwnd=[WU]::FindFMPRO()
if($hwnd -eq [IntPtr]::Zero){ Write-Output "FMPRO_NOT_FOUND"; exit 1 }
[WU]::ShowWindow($hwnd,3)|Out-Null; [WU]::SetForegroundWindow($hwnd)|Out-Null; Start-Sleep -Milliseconds 250
$root=$AE::FromHandle($hwnd)

function Aid($a){ if($a -like 'Field: *'){ return $a } else { return "Field: Docs::$a" } }
function ByAid($a){
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty,(Aid $a))
  return $root.FindFirst($TS::Descendants,$c)
}
function ByName($n,$ct){
  $c1 = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty,$n)
  return $root.FindFirst($TS::Descendants,$c1)
}
function Invoke($el){ $o=$null; if($el.TryGetCurrentPattern($P_Inv,[ref]$o)){ $o.Invoke(); return $true }; return $false }

switch($Cmd){
  "get" {
    $el=ByAid $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    $o=$null; if($el.TryGetCurrentPattern($P_Val,[ref]$o)){ Write-Output ("value=" + $o.Current.Value) } else { Write-Output "NO_VALUE_PATTERN (ct=" + ($el.Current.ControlType.ProgrammaticName) + ")" }
  }
  "header" {
    # The invoice's title bar is a Button named e.g. "Invoice: 90807    (Not Issued)" / "... (Issued)".
    # Reading it gives the EXACT open invoice number + issued-state = the number-match guarantee.
    $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)
    $btns = $root.FindAll($TS::Descendants,$cond)
    foreach($b in $btns){
      $n = $null; try { $n = $b.Current.Name } catch {}
      # An invoice CONVERTED FROM A JOB SHEET carries a "( JS: nnnnn )" reference between the
      # number and the state - e.g. "Standard Invoice: 90824 ( JS: 93238 )  (Issued)". The old
      # pattern allowed only whitespace there, so it silently failed to match every
      # job-sheet-derived invoice - exactly the kind staff create by hand. A failed match
      # reads as "no invoice open", which made ga4_scan_new report real records as missing.
      if($n -and $n -match 'Invoice:\s*(\d+)\b.*?\((Not\s+)?Issued\)'){
        $num = $Matches[1]; $issued = if($Matches[2]){ 'NotIssued' } else { 'Issued' }
        Write-Output ("header num=$num state=$issued raw='" + $n.Trim() + "'"); break
      }
    }
  }
  "findtext" {
    # Walk the whole UIA tree and report any element whose Name CONTAINS $A1, with its physical
    # bounding rect. Used to CONFIRM the open invoice's header number matches the target (the header
    # "Standard Invoice: <n>" number is a Text child of a custom pane, unreachable by FromPoint).
    $all = $root.FindAll($TS::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $hits = 0
    foreach($e in $all){
      $n = $null; try { $n = $e.Current.Name } catch {}
      if($n -and $n.Contains($A1)){
        $r = $e.Current.BoundingRectangle
        Write-Output ("HIT name='$n' ct=" + $e.Current.ControlType.ProgrammaticName + " rect=" + [int]$r.X + "," + [int]$r.Y + "," + [int]$r.Width + "," + [int]$r.Height)
        $hits++
      }
    }
    if($hits -eq 0){ Write-Output "NO_HIT '$A1'" }
  }
  "readpt" {
    # Read the display TEXT at a SCREEN point (physical px). The Totals panel (SubTotal/VAT/MOT/
    # Total/Balance) is display-only Text with no ValuePattern, so `get` can't read it — but each
    # value is a Text element readable via AutomationElement.FromPoint by its Name. $A1=x $A2=y.
    $pt = New-Object System.Windows.Point([double]$A1,[double]$A2)
    $el = $AE::FromPoint($pt)
    if(-not $el){ Write-Output "NO_ELEMENT"; break }
    $nm = $el.Current.Name
    $o=$null; $val = ""
    if($el.TryGetCurrentPattern($P_Val,[ref]$o)){ $val = $o.Current.Value }
    $show = $val; if([string]::IsNullOrEmpty($show)){ $show = $nm }
    Write-Output ("readpt=" + $show + " | name='" + $nm + "' ct=" + $el.Current.ControlType.ProgrammaticName)
  }
  "setval" {
    $el=ByAid $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    $o=$null; if($el.TryGetCurrentPattern($P_Val,[ref]$o)){ $o.SetValue($A2); Start-Sleep -Milliseconds 200; Write-Output ("set. now=" + $o.Current.Value) } else { Write-Output "NO_VALUE_PATTERN" }
  }
  "fill" {
    # Reliable text entry that COMMITS (unlike setval/ValuePattern.SetValue which
    # writes a value without firing FileMaker's field-exit triggers). Works for
    # header Edit fields AND portal line-item cells. SetFocus -> select-all ->
    # type -> Tab (commit + fire lookup/recalc). Use $A2 trailing '~' to send Enter
    # instead of Tab (e.g. registration lookup) by passing commit key in $A3-less form.
    $el=ByAid $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    try { $el.SetFocus() } catch { Write-Output ("SetFocus failed: " + $_.Exception.Message); break }
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 120
    $safe = $A2 -replace '([+^%~(){}])','{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($safe); Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}"); Start-Sleep -Milliseconds 400
    $o=$null; $now=''; if($el.TryGetCurrentPattern($P_Val,[ref]$o)){ $now=$o.Current.Value }
    Write-Output ("fill '$A1' = '$A2' (focus+select+type+tab) now='$now'")
  }
  "setmenu" {
    # FileMaker pop-up menu value lists are custom-drawn and NOT in the UIA tree,
    # so we can't invoke an item. Instead: UIA SetFocus (pixel-free, reliable) then
    # keyboard type-ahead + Enter, which FileMaker resolves against the value list.
    $el=ByAid $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    try { $el.SetFocus() } catch { Write-Output ("SetFocus failed: " + $_.Exception.Message); break }
    Start-Sleep -Milliseconds 350
    [System.Windows.Forms.SendKeys]::SendWait($A2); Start-Sleep -Milliseconds 250
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Start-Sleep -Milliseconds 400
    Write-Output "setmenu '$A1' = '$A2' (focus+type-ahead+enter)"
  }
  "button" {
    $el=ByName $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    Write-Output ("invoke button '{0}' = {1}" -f $A1,(Invoke $el))
  }
  default { Write-Output "unknown cmd: $Cmd" }
}
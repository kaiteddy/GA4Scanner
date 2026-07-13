# GA4 UI-Automation driver (no pixels, no popups-by-image).
# Commands:
#   ga4_uia.ps1 get     <fieldAid>              read an Edit field's value
#   ga4_uia.ps1 setval  <fieldAid> <text>       set an Edit field via ValuePattern
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
  "setval" {
    $el=ByAid $A1; if(-not $el){ Write-Output "NOT_FOUND"; break }
    $o=$null; if($el.TryGetCurrentPattern($P_Val,[ref]$o)){ $o.SetValue($A2); Start-Sleep -Milliseconds 200; Write-Output ("set. now=" + $o.Current.Value) } else { Write-Output "NO_VALUE_PATTERN" }
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
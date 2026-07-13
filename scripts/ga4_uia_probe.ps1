# UIA feasibility probe for GA4 (FileMaker). Read-only.
# Attaches to the FMPRO window, does a bounded tree walk, summarises control types,
# and lists candidate controls: comboboxes/lists, and buttons named Save/Issue, etc.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string n);
  public static IntPtr FindFMPRO() {
    IntPtr h = IntPtr.Zero;
    while ((h = FindWindowEx(IntPtr.Zero, h, null, null)) != IntPtr.Zero) {
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString().ToUpper().Contains("FMPRO")) return h;
    }
    return IntPtr.Zero;
  }
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int c);
}
"@

$hwnd = [W]::FindFMPRO()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "FMPRO_NOT_FOUND"; exit 1 }
Write-Output "FMPRO hwnd=$hwnd"

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
Write-Output ("root name=" + $root.Current.Name + " class=" + $root.Current.ClassName)

$Auto = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

$typeCounts = @{}
$candidates = New-Object System.Collections.Generic.List[string]
$script:count = 0
$MAX = 4000

function Patterns($el) {
  $p = @()
  foreach($pat in @(
    @('Value',[System.Windows.Automation.ValuePattern]::Pattern),
    @('SelectionItem',[System.Windows.Automation.SelectionItemPattern]::Pattern),
    @('ExpandCollapse',[System.Windows.Automation.ExpandCollapsePattern]::Pattern),
    @('Invoke',[System.Windows.Automation.InvokePattern]::Pattern),
    @('Selection',[System.Windows.Automation.SelectionPattern]::Pattern),
    @('Toggle',[System.Windows.Automation.TogglePattern]::Pattern))) {
    $obj = $null
    if ($el.TryGetCurrentPattern($pat[1], [ref]$obj)) { $p += $pat[0] }
  }
  return ($p -join ',')
}

function Walk($el, $depth) {
  if ($script:count -ge $MAX) { return }
  $script:count++
  $ct = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
  if (-not $typeCounts.ContainsKey($ct)) { $typeCounts[$ct] = 0 }
  $typeCounts[$ct]++
  $name = $el.Current.Name
  $aid  = $el.Current.AutomationId
  $pats = Patterns $el
  # candidates of interest
  if ($ct -in @('ComboBox','List','ListItem') -or
      $pats -match 'SelectionItem|ExpandCollapse|Value' -or
      ($name -and ($name -match '^(Save|Issue|Pass|Fail|Convert|Delete|MOT.*)$'))) {
    $candidates.Add(("d{0} [{1}] name='{2}' aid='{3}' pats={4}" -f $depth,$ct,$name,$aid,$pats))
  }
  $child = $walker.GetFirstChild($el)
  while ($child -ne $null -and $script:count -lt $MAX) {
    Walk $child ($depth+1)
    $child = $walker.GetNextSibling($child)
  }
}

Walk $root 0
Write-Output "--- nodes walked: $($script:count) (cap $MAX) ---"
Write-Output "--- control type counts ---"
$typeCounts.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object { Write-Output ("  {0,-16} {1}" -f $_.Key,$_.Value) }
Write-Output "--- candidate controls ($($candidates.Count)) ---"
$candidates | ForEach-Object { Write-Output $_ }
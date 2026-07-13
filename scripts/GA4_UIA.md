# GA4 automation via UI Automation (the reliable way)

**This is the recommended way to drive GA4 — not screenshot+pixel-clicking.**
GA4 is FileMaker Pro Runtime (window class `FMPRO14.0RUNTIME`), and it exposes a rich,
*named* UI Automation tree: every field, button and tab is addressable by a stable
AutomationId — no coordinates, no DPI issues, no popup-timing, no OCR.

Built on **System.Windows.Automation** (ships with .NET / Windows — nothing to install).

## Tools
- `ga4_uia_probe.ps1` — dump the UIA tree of the current GA4 window (control types,
  names, AutomationIds, supported patterns). Run this on any screen to discover its fields.
- `ga4_uia.ps1` — the driver:
  ```
  ga4_uia.ps1 get     <fieldAid>            read an Edit field value
  ga4_uia.ps1 setval  <fieldAid> <text>     set an Edit field (ValuePattern)
  ga4_uia.ps1 setmenu <fieldAid> <option>   set a pop-up menu field (focus + type-ahead + Enter)
  ga4_uia.ps1 button  <name>                invoke a toolbar button by name
  ```
  `<fieldAid>` may omit the `Field: Docs::` prefix (added automatically).

## Control-type → method (this GA4 build, invoice/job-sheet layout)
| UIA type | How to set | Example AutomationIds |
|---|---|---|
| **Edit** | `setval` (ValuePattern.SetValue) | `vehMileage`, `vehRegistration`*, `custAddress_PostCode`, `docOrderRef`, `motQty`, `motPriceDisplay` |
| **Menu** (FileMaker pop-up value list) | `setmenu` (SetFocus + keyboard type-ahead + Enter) | `motStatus`, `motClass`, `motType`, `staffMOTTester`, `docDepartment`, `docTermsandConditions`, `staffSalesPerson` |
| **Button** | `button` (InvokePattern.Invoke) | `Save`, `Issue`, `Draft`, `Convert`, `Delete`, `VRM Lookup`, `Transactions` |
| **Calendar** | ValuePattern | `docDate_Created`, `docDate_DueBy` |
| **ComboBox** | ValuePattern | `custAccountNumber`, `Docs_Vehicle::Make`, `Docs_Vehicle::Model` |

\* `vehRegistration` is a ComboBox (Value pattern) — `setval` works.

## KEY finding — pop-up menu fields
FileMaker pop-up menu fields (`motStatus` etc.) are UIA **Menu** controls exposing only
**Invoke**. Invoking opens the value list, but **that list is custom-drawn and does NOT
appear in the UIA tree** — you cannot select an item by UIA, and clicking it by pixel is
flaky (it was the whole earlier blocker). The reliable fix: **UIA `SetFocus()` on the
field, then send the option text as keystrokes + Enter** — FileMaker resolves the typed
text against the value list. `setmenu` does exactly this. Verified: `setmenu motStatus Pass`
sets MOT Status = Pass cleanly, no popup left open.

## Example: finish an MOT invoice
```
ga4_uia.ps1 get     vehMileage            # verify mileage
ga4_uia.ps1 setmenu motStatus Pass        # set MOT result
ga4_uia.ps1 button  Save                  # commit draft
ga4_uia.ps1 button  Issue                 # issue (then handle Issue-Only / MOT-reminder dialogs)
```

## Notes
- Buttons that show a `▼` (e.g. `Convert ▼`, `Draft ▼`) are the split-menu variants; the
  plain-named one (`Convert`, `Issue`) is usually the primary action.
- `Issue` may raise a confirmation ("Issue Only") and an MOT-reminder prompt — enumerate the
  dialog with `ga4_uia_probe.ps1` and invoke the right button by name.
- Reads never modify anything — safe to run freely. `setval`/`setmenu`/`button Save|Issue`
  modify the live document; treat like real data entry.

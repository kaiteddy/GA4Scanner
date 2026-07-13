# GA4 native-Windows automation — working notes

Verified 2026-07-13 against live **Garage Assistant GA4 v4.046 Standalone** running
natively on Windows 11 (NOT Parallels). All primitives reliable.

## The helper: `ga4.ps1`

DPI-aware PowerShell driver. Subcommands (all re-focus GA4 and re-capture after acting):

```
ga4.ps1 shot   <out.png>
ga4.ps1 click  <imgX> <imgY> [out.png]
ga4.ps1 dclick <imgX> <imgY> [out.png]   # double-click, e.g. open a record
ga4.ps1 type   <text> [out.png]          # SendKeys into focused field
ga4.ps1 key    <vk-hex> [out.png]        # e.g. 0x1B Escape, 0x0D Enter
```

`imgX/imgY` are pixel coords **in the captured window image**, whose top-left = window
top-left. Mapping is 1:1 because the process calls `SetProcessDPIAware()` first, so
screenshot capture and mouse events share one physical-pixel space.

### CRITICAL — DPI
Display runs at **200% scaling** (physical 3028×2382; a DPI-unaware process sees
1514×1191). Without `SetProcessDPIAware()`, clicks land 2× off target. This was the
whole "flakiness" cause. Do NOT remove the DPI-aware call.

## UI facts learned

- **Maximize first** for stable, full-UI automation: `ShowWindow(hwnd, 3)`. Maximized
  window rect ≈ (-4,-4) size 3036×2294. Half-width default (~1482 wide) hides columns
  and buttons.
- Logged in as **Admin**. Full nav bar only shows maximized: Home, Calendar, Estimates,
  Job Sheets, Invoices, Veh Sales, Unpaid, Archives, Customers, Vehicles, Stock,
  Reminders, + Admin / Sign Out (top-right).
- **Open a job sheet/invoice**: double-click its row, OR click the **Open** button at the
  right end of the row. Single click only selects (row highlights cyan).
- **Close a record back to the list**: the red **X** at the top-right of the record's
  purple header (next to the gear icon). `Escape` does NOT close it. (Separate red X's
  next to Registration/Acc-Number fields just clear those fields — don't confuse them.)
- Customer Database loads empty ("0 of Records") until you search — it does not preload.

## Nav-bar coords (MAXIMIZED window, image px from window top-left)

| Target      | x    | y   |   | Target    | x    | y   |
|-------------|------|-----|---|-----------|------|-----|
| Home        | 76   | 134 |   | Archives  | 1069 | 134 |
| Calendar    | 217  | 134 |   | Customers | 1212 | 134 |
| Estimates   | 360  | 134 |   | Vehicles  | 1354 | 134 |
| Job Sheets  | 501  | 134 |   | Stock     | 1497 | 134 |
| Invoices    | 644  | 134 |   | Reminders | 1639 | 134 |
| Veh Sales   | 786  | 134 |   | Admin     | 2775 | 134 |
| Unpaid      | 928  | 134 |   | Sign Out  | 2915 | 134 |

Verified: Home, Calendar, Customers. Others derived from even spacing — re-screenshot to
confirm before relying on them. Coords are only valid while the window stays maximized.

## Safety
- Never click **Save**/**Delete**/**Sign Out** or type into fields during read-only tasks.
- Screenshot before AND after any data change for an audit trail.

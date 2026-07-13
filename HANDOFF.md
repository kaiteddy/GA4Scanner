# GA4Scanner — session handoff (2026-07-13)

## Working & proven
Native-Windows GA4 automation is solid. Driver: `scripts/ga4.ps1` (DPI-aware).
See `scripts/GA4_NOTES.md` for the full recipe, nav coords, and UI gotchas.

Verified end-to-end against live GA4 v4.046: focus → screenshot → read → click →
double-click to open a record → close (header red X) → back to list. The key fix was
making the process DPI-aware (display is 200% scaling), which gives 1:1 screenshot↔click.

## In progress — MOT invoice for VK58 OET
Goal: create an **MOT invoice** in GA4 for reg **VK58 OET**, with the **mileage** taken
from the `mot-reminder-quick` web app.

Progress so far:
- Created **Job Sheet 93218** in GA4 and entered reg **VK58 OET** (GA4 auto-formatted it
  with the space). Vehicle details are blank — VK58 OET is NOT in the local GA4 database,
  so nothing auto-populated. The sheet was left OPEN (not saved, no VRM lookup run).
- Decided the deliverable is an MOT **invoice** (via New Invoice, or Convert from the job
  sheet), with mileage going into the invoice's mileage field.

### Blocker (why we stopped)
Mileage source = **mot-reminder-quick** web app: <https://mot-reminder-quick.vercel.app>
(deployed on Vercel; repo `kaiteddy/mot-reminder-quick`). It opens an **ELI MOTORS LTD
admin login**. Claude will not submit login credentials, and the user couldn't get to the
browser window to click **Sign In**. So we never reached the dashboard to read VK58 OET's
mileage.

## Next steps (to pick up)
1. **User signs in** to mot-reminder-quick (click Sign In — password is saved in the
   browser). The automation opens its own Chrome window/tab group — look for the window
   titled "Eli Motors".
2. Find **VK58 OET** in the app; read its **latest MOT odometer / mileage**.
3. In GA4: decide job sheet 93218 → **Convert to Invoice**, OR start a fresh **New Invoice**
   for VK58 OET. (First confirm whether 93218 should be kept, completed, or deleted — it's
   currently an empty open job sheet.)
4. Enter the mileage in the invoice's **Mileage** field; add the MOT line/fee.
5. Optionally run **VRM Lookup** (DVLA — may cost a credit; ask first) to fill vehicle
   details. Then **Save**.

## Notes
- Logged into GA4 as **Admin**; keep the GA4 window **maximized** for stable coords.
- Don't click Save/Delete/Sign Out or type into fields except where intended.

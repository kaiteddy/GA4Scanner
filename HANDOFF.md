# GA4Scanner — session handoff (2026-07-21)

## Working & proven
Native-Windows GA4 automation is solid. Drivers:
- `scripts/ga4.ps1` — DPI-aware pixel/keyboard primitives (`click`, `cell`, `gridrow`, `key`, `shot`)
- `scripts/ga4_uia.ps1` — pixel-free UI Automation (`get`, `fill`, `setmenu`, `header`, `readpt`, `findtext`, `button`)
- `scripts/ga4_search.ps1` — Quick Search helper
- `scripts/ga4_fill.ps1` — one-command invoice fill from a work-order JSON, with identity + total guards

See `scripts/GA4_NOTES.md` (coords, UI gotchas) and `scripts/GA4_UIA.md` (control-type → method map).

## Done
- **2026-07-20**: 5 invoices filled with exact totals; `gridrow` keyboard Tab-nav solved the
  preset-labour problem (a preset autocomplete popup was swallowing the Qty/Price cell clicks).
- **2026-07-21**: **invoice 90807 (EX03 BOF, Mrs Ayalah Hirst, £411.00) ISSUED** and verified
  (`header` → `Standard Invoice: 90807 (Issued)`, total 411.00). Issued via **Issue Only** — no
  payment recorded, so the £411.00 balance stays outstanding.

## Issue-flow dialog chain (verified live, 2026-07-21)
Clicking **Issue** does NOT go straight to the payments dialog. Actual sequence:
1. **Issue** (img 377,207) → *MOT Reminder* prompt: "An existing reminder is due soon…"
   → **Ok** (img 1897,1193).
2. → *Vehicle Reminders* dialog, pre-filled with **52 weeks from today**. This default is often
   wrong: under the DVSA early-test rule (tested within a month before the old expiry, the new
   certificate keeps the anniversary), the due date should be **old expiry + 1 year**.
   Set the date with `ga4.ps1 cell 1394 760 "<dd/mm/yyyy>"`, then **Update Reminder** (img 1562,1131).
   For 90807: GA4 offered 20/07/2027; correct value was **26/07/2027** (old expiry 27/07/2026).
3. **Close** the reminders dialog (img 1224,629). The invoice is still **Not Issued** at this point —
   the reminder prompt interrupts the issue flow and it must be restarted.
4. **Issue** again → *Issue Invoice / Add Payments* → **Issue Only** (img 2060,728).
5. Verify: `ga4_uia.ps1 header` must report `(Issued)`; Invoices-In-Progress count drops by one.

`ga4_fill.ps1`'s step-10 blind AbsClick chain does NOT match this sequence — it assumes
"Yes(Auto)" reminder dialogs. **Fix it or keep issuing supervised.**

## Next steps
1. **90808** — not started. No `wo_90808.json` exists yet; needs generating from the source
   (Neon `serviceHistory` + `serviceLineItems`) before `ga4_fill.ps1` can run.
2. Mark the pool row filled:
   `UPDATE "ga4NumberPool" SET status='filled', "filledAt"=now() WHERE "ga4Number"='90807';`
   *(not yet done for 90807)*
3. Reconcile `ga4_fill.ps1` step 10 with the real dialog chain above.

## Notes
- Logged into GA4 as **Admin**; keep the GA4 window **maximized** for stable coords (display is
  200% scaling; all coords are physical px, window origin ~(-4,-4), size 3404x2184).
- **Shared-session hazard**: GA4 is a live shared app. On 2026-07-20 an automated Issue click landed
  on a colleague's open job sheet (93232) and hit Print. **Always check nobody else is in GA4 first.**
  `scratchpad/peek.ps1`-style capture (screenshot without `SetForegroundWindow`) checks state
  non-intrusively.
- Always run the identity guard (`ga4_uia.ps1 header`) before writing to or issuing any record.
- Don't click Save/Delete/Sign Out or type into fields except where intended.

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
- **2026-07-21**: **90807** (EX03 BOF, Mrs Ayalah Hirst, **£411.00**) and **90808** (EA66 VBM,
  Mrs Aviva Mentzer, **£45.58**) both **ISSUED** and verified (`header` → `(Issued)`, totals read
  back exactly). Both via **Issue Only** — no payment recorded, so the balances stay outstanding.
  Both pool rows marked `filled` in Neon (`garagemanagerpro` / `wispy-lake-94196757`).

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

The chain VARIES by invoice content — there is no single fixed click sequence:
- **MOT on the invoice + vehicle already has an MOT reminder** → "An existing reminder is due soon"
  → Ok → *Vehicle Reminders* (Update Reminder) → Close → **Issue again**.
- **MOT + vehicle has NO reminder** → "Would you like to set an MOT reminder?" with
  **No / Yes (Auto) / Yes (Edit)**. Yes (Edit) opens the same dialog with an **Add Reminder**
  button and is non-committal — prefer it when the date needs checking.
- **Service/oil-change work on the invoice** → a separate **Service Reminder** prompt
  (No / Yes (Auto) / Yes (Edit)), which appears *after* the MOT one.
- **No MOT** → no MOT prompt at all.
- Account customers open as **"Account Invoice"** not "Standard Invoice"; the payments dialog says
  payments are optional and the balance is managed on the customer account. `header` still matches.

### MOT reminder due dates — get this right
The reminder due date should be the **new certificate expiry**, not "52 weeks from today"
(GA4's default, which is usually wrong).
- Vehicle HAS a prior expiry and was tested within the month before it → **the expiry date is
  preserved exactly**: old expiry + 1 year (e.g. 30/07/2026 → 30/07/2027).
- No prior expiry known → test date + 12 months, expiring the day before the anniversary
  (tested 17/07/2026 → 16/07/2027).
Read the existing date from the "N Existing Reminders for: <REG>" grid in the dialog before typing.

`ga4_fill.ps1`'s step-10 blind AbsClick chain does NOT match any of this — it assumes a fixed
"Yes(Auto)" chain. **Keep issuing supervised until it is rewritten to branch on what appears.**

## Portal line-item entry — what works (verified live on 90808, 2026-07-21)
Labour columns are **Desc | Tech | Qty | Unit Price**. Two traps:
1. Committing the Description opens the **Tech pop-up menu**, which physically covers the
   Qty/Price cells — clicks aimed at them hit the menu and the value never arrives.
   **Send Escape after every cell commit.**
2. **`gridrow` is wrong for a fresh, empty portal row.** GA4 creates the row on commit and returns
   focus to Description, so the qty overwrites the description and the price is lost. It produced a
   labour row literally described `"0.5"` with no price. `gridrow` is still fine for rows that
   already exist; `ga4_fill.ps1` now uses per-cell clicks + Escape throughout.

Also: while a popup is open FileMaker **blanks MainWindowTitle**, so the title-based
`Get-Process` lookup fails and every command dies `GA4_NOT_FOUND` — including the Escape needed to
close the popup. `ga4.ps1` now falls back to finding the window by **class** (`FMPRO*`).

## Reconciliation state (2026-07-21)
Backlog cleared: **90809 £45.00, 90810 £663.94, 90811 £300.68, 90812 £355.42** all filled, issued
and pool-marked `filled`, each verified to the penny. With 90807/90808 that is 6 issued today.

Outstanding:
1. **90813** — claimed 2026-07-21 08:49 by web doc 420631 (Mr Kass, 241DK, MOT £45.00,
   mileage 14927) *while this session was running*. Not started.
2. **90800** — web doc 420605 (Bezalel, EX10 ZYR, £77.22) is still `docStatus='New'` and has no
   `ga4Number` stamped. Looks like a genuine draft, not backlog — confirm before filling.
3. **90799** — an empty blank in GA4 that the pool does not track at all (pool starts at 90800).
4. **90814** — the only remaining `available` blank. **Pool is nearly dry; replenish soon.**
5. Web doc 90853 (id 420618, Mrs Vecht, V3CHT) is £0.00 / `New` with no pool claim — likely abandoned.

## Next steps
1. Fill **90813** from doc 420631 (MOT-only, same shape as 90809).
2. Create more blanks in GA4 and add them to the pool — only 90814 is free.
3. Rewrite `ga4_fill.ps1` step 10 (`-Issue`) to branch on the dialog actually shown (see chain
   above). Until then **always run without `-Issue`** and issue supervised.
4. Consider filling the Part Number column for parts lines (web `partNumber` is currently dropped).

## Notes
- Logged into GA4 as **Admin**; keep the GA4 window **maximized** for stable coords (display is
  200% scaling; all coords are physical px, window origin ~(-4,-4), size 3404x2184).
- **Shared-session hazard**: GA4 is a live shared app. On 2026-07-20 an automated Issue click landed
  on a colleague's open job sheet (93232) and hit Print. **Always check nobody else is in GA4 first.**
  `scratchpad/peek.ps1`-style capture (screenshot without `SetForegroundWindow`) checks state
  non-intrusively.
- Always run the identity guard (`ga4_uia.ps1 header`) before writing to or issuing any record.
- Don't click Save/Delete/Sign Out or type into fields except where intended.

# create_invoice — register a web invoice into GA4, return the authoritative number

> **E2E TEST PASSED 2026-07-06** on the hardened server (draft 90706, LD10 VCZ): VRM lookup +
> AccNo verify, all four MOT Extras set, mileage, labour line (paste), parts line (paste),
> **totals gate matched to the penny (60.00 net / 12.00 VAT / 45.00 MOT / 117.00 total)**,
> held at Issue, draft deleted + verified gone. Every step below is now live-verified except
> the final Issue click (needs a real invoice + user go-ahead).

Purpose: given a completed invoice from the web app (garagemanagerpro), create it in GA4
**itemised and exact**, verify GA4's computed total matches, **Issue** it, and return the
GA4 invoice number so the web app prints the aligned number. Replaces the docNoClearance
guess-ahead scheme — GA4 becomes the single source of truth for the number.

Runs as an agent procedure over the `garage-assistant` MCP tools (screenshot, click,
paste_field, select_dropdown, click_menu_button, press_key), on the hardened +
speed-optimized server (cached activation, consolidated paste/dropdown-select/menu-click).
The agent reads the screenshot to verify each step and to read the assigned number.

## Input contract
```
{
  webInvoiceId: string,        // idempotency key (web record id)
  reg: string,                 // vehicle registration — drives VRM Lookup (vehicle + customer)
  customerAccNo: string,       // expected GA4 account no, to verify VRM Lookup pulled the right customer
  mileage: number,
  jobDescription?: string,     // free-text "work performed" summary — goes in the Description
                                // tab, NOT a labour/parts line (see step 4b). Optional: many
                                // real invoices leave it blank and rely on itemised lines alone.
  labour: [{ description, qty, unitPrice, vatCode? }],   // vatCode default T1 (20%)
  parts:  [{ description, qty, unitPrice, vatCode? }],
  expectedNet: number,         // from web app — the correctness gate
  expectedVat: number,
  expectedTotal: number
}
```

## EXACTNESS (the hard requirement)
The GA4 invoice must be a **verbatim reproduction of the web-app invoice** — every line
description, labour, part, MOT, qty, unit price, VAT code, mileage, dates — **exactly** as
written in the web app. **A matching total is NOT sufficient** (the same £ total can hide a
wrong description). The web-app invoice is the single source of truth; GA4 must be made to
match it, character-for-character.

**Exact text entry — use the `paste_field` tool** (clipboard-set + click + select-all + paste
in one call — see Speed section below for why this replaced the old 4-step manual sequence).
This is **deterministic** — it reproduces any characters (`& + ( ) : " '`) exactly and CANNOT
scramble (unlike scancode typing, which put a Qty digit in the Description cell during the
first supervised run). This is what makes field-level exactness achievable.

**Per-field verification — after each field:**
- Primary: because paste is deterministic, verify the field is **populated and visually
  correct** (screenshot). A paste either lands exactly or visibly fails (empty field) → retry.
- Char-level read-back (`ctrl+a`→`ctrl+c`→read clipboard) is UNCONFIRMED — Ctrl+C didn't
  update the clipboard in testing (focus-dependent). Don't rely on it yet; paste-determinism
  is the primary guarantee.
- ANY populated-but-wrong or failed field after retry → **ABORT, do not Issue**, flag.

**Never accept a GA4 default silently** — GA4 auto-fills that must be OVERRIDDEN to the
web-app value: labour Unit Price default **£70**; per-line **VAT code** (verify == web app);
**VRM-Lookup** vehicle/customer (verify == web app — a difference means a data-sync issue to
resolve and flag, not silently accept).

**MOT — MAPPED (2026-07-03).** Not a labour/parts line; set via the **Extras** panel (right),
and the fee lands on the **separate MOT line in Totals** (outside SubTotal/VAT — MOT is zero-rated).
Fields (small targets — set each, then verify the displayed value):
- **MOT** dropdown — the type: **None / Full / Retest / Duplicate** (CONFIRMED live 2026-07-03);
  selecting a type enables a fee/qty box beside it `(~1155,564)`.
- **MOT Class** dropdown — pricing tier that drives the fee: **TYPE A - RETAIL, TYPE A - TRADE,
  TYPE B - RETAIL, TYPE B - TRADE, TYPE C - RETAIL, TYPE C - TRADE** (CONFIRMED live 2026-07-03).
- **MOT Status** dropdown — result. Historical values in ga4.sqlite `Documents.motStatus`:
  **Pass / Fail / Pass Retest / Fail Retest** (13k+ docs); confirm the live list on next run.
- **MOT Tester** dropdown — tester name. DB stores staff GUIDs (6 distinct in
  `Documents.staffMOTTester`); names must be enumerated from the live dropdown.

**Extras-dropdown interaction (E2E-VERIFIED 2026-07-06):**
- Click the **value box** (e.g. `(1120,565)` for MOT, `(1130,577)` for Class) — clicking the
  tiny ▼ arrow does NOT open the popup.
- **With a popup open, Ctrl+V and most keys are EATEN by the popup** (Tab still moves focus,
  which masks the failure — fields end up EMPTY). Do not paste into popup fields. Arrow-keys +
  return DO NOT reliably commit either (tried and failed twice, 2026-07-06) — click the option.
- **USE THE `select_dropdown` TOOL — not separate click calls.** Root-caused 2026-07-06: a
  bare click(open) → click(option) → click(next field) sequence has a race — if the popup
  hasn't visually closed yet, the "next field" click lands inside the still-open popup instead,
  silently changing the wrong value. `select_dropdown(anchorX, anchorY, optionX, optionY)` does
  open+select+a 900ms settle as ONE call, so the popup is guaranteed closed before your next
  action. This is not optional politeness — it was the actual cause of a wrong MOT Class value
  making it into a gate-passing invoice on the first 2026-07-06 attempt.
- **Calibrated option coordinates (image-space)** — skip the capture-crop-measure discovery
  cycle for these, they're measured and CONFIRMED by a real click unless marked otherwise:
  - MOT type anchor `(1120,565)`: **Full `(1115,570)`** CONFIRMED. Retest `(1115,576)`,
    Duplicate `(1115,581)` — extrapolated from the ~5.6px row pitch, NOT yet click-tested;
    verify the first time.
  - MOT Class anchor `(1130,577)`: **TYPE A - RETAIL `(1128,575)`** CONFIRMED (also confirmed
    via the Totals MOT fee → £45.00). TYPE A - TRADE `(1128,581)`, TYPE B - RETAIL `(1128,586)`,
    TYPE B - TRADE `(1128,592)`, TYPE C - RETAIL `(1128,597)`, TYPE C - TRADE `(1128,603)` —
    extrapolated, not yet click-tested.
  - MOT Status anchor `(1130,590)`: **Pass `(1116,587)`** CONFIRMED. Pass Retest `(1116,593)`,
    Fail `(1116,598)`, Fail Retest `(1116,604)` — extrapolated, not yet click-tested.
  - MOT Tester anchor `(1130,603)`: not yet opened/clicked in any run (GA4 has been carrying
    over a prior default — "DB | Dec" — every time). Options confirmed live: Dec Buckley /
    Doug Brittain / Eli Rutstein / Kevin Peach. Coordinates unknown — run the capture-crop
    discovery once, then add the confirmed coordinate here.
  - If any extrapolated coordinate misses (lands on the row above/below), re-measure via
    native capture (see Speed section) rather than nudging blindly — get it right once, add
    it here as CONFIRMED, don't leave the guess in place.
- Committed values display TRUNCATED in the narrow boxes ("TYPE A - ", "DB | Dec") — verify
  via a side-effect where possible (Class → the Totals **MOT fee** populates; TYPE A - RETAIL
  = **£45.00** at ELI) rather than re-opening the field.
For exactness: set MOT type + Class(pricing tier) + Status + Tester + fee to match the web
app's MOT, and confirm the Totals **MOT** line equals the web app's MOT amount.

## Idempotency (do FIRST, before touching GA4)
- If the web record already has a `ga4Number`, **ABORT — already registered.** Never create twice.
- The **`ga4Number` column now EXISTS** on `serviceHistory` (garagemanagerpro Neon, added 2026-07-06,
  `varchar`, nullable). This is the reconciliation key — GA4 issues the number, we stamp it here.

## Recording the number back (step 9) — use `ga4Number`, NOT a `docNo` overwrite
GA4 is the single source of truth for the number; the web app must match it. Record it by setting
`serviceHistory.ga4Number` on the web record — **do NOT overwrite `docNo`.** Web-created invoices
(`externalId LIKE 'WEB-%'`) carry guess-ahead `docNo`s that are denser and higher than GA4's real
numbers, so overwriting `docNo` to GA4's number **cascades**: e.g. 2026-07-06, Knoller web 90732 →
GA4 90708, but web 90708 was already Charles Hammond's belt job, whose GA4 number 90709 was already
another web invoice (Lustigman), etc. ~20 web-created invoices (docNo 90684–90735) sit in this state.
One-at-a-time docNo alignment is impossible; only a coordinated batch-migration (with a temp offset)
could align docNos, and it re-collides whenever a new web invoice is created. So: **stamp `ga4Number`,
leave `docNo`.** For the web app to *display/print* the matching number, its invoice-number logic must
prefer `ga4Number` when present (webapp code change, tracked separately). See [[web-ga4-doc-numbering]]
and [[ga4-number-reconciliation]].

## Step sequence
Each step: perform the action, then **screenshot and verify the expected state before
continuing**. On ANY unexpected state or value mismatch → **ABORT without issuing** and
flag for a human (an unissued draft is harmless; a wrong issued invoice is not).

1. **Go to Invoices view** — click Invoices nav icon `(213,40)`. Verify header "Invoices In Progress".
2. **New Invoice** — click `(48,113)`. Verify a draft opened: header `Invoice: <n> (Not Issued)`.
   Record `n` = candidate number (GA4 assigns at creation).
3. **Attach vehicle + customer** — click Registration field `(135,91)`, type `reg`; click
   **VRM Lookup** `(312,91)`.
   - If **"Warning - Open Document Exists"** dialog appears (vehicle already has an open invoice):
     this is likely a prior failed attempt for this same job → **ABORT and flag** (don't blindly
     stack a duplicate). Click Ignore only if policy says a second concurrent invoice is intended.
   - Verify the vehicle block filled (Make/Model non-empty) AND the customer block filled.
   - **Verify `Acc Number` == `customerAccNo`.** Mismatch → ABORT (wrong vehicle/owner).
4. **Mileage** — click Mileage field `(119,199)`, type `mileage`.
4b. **Job Description (MAPPED 2026-07-06, if `jobDescription` given)** — click **Description**
   tab `(118,254)`: a free-text box (not a labour/parts line, no price/VAT) with a "Pre-set
   descriptions" dropdown above it and a footer note ("~35 lines will print; for more use
   zero-qty/priced labour lines, Shift+Enter for a new line"). Click the text box (~(520,400))
   and paste `jobDescription` verbatim. This tab was found EMPTY on a real live invoice
   (90707) — treat as optional, only fill when the web app actually has a job-description
   field to carry over; don't invent content.
   **Known GA4-side transform (2026-07-06):** GA4 auto-Title-Cased a pasted sentence
   ("Diagnostic check and oil filter..." became "Diagnostic Check And Oil Filter...") on
   display. That's GA4 reformatting the field, not a paste failure — don't treat a case
   change alone as a mismatch when verifying this field.
5. **Labour lines** — click **Labour** tab `(191,254)`. For each labour item, on the empty
   ("Job Lookup") row:
   - Description cell `(200,294)` → type description
   - Qty cell `(~840,294)` → type qty   ← small target; verify it landed, retry if blank
   - Unit Price cell `(~877,294)` → type unitPrice
   - click off the row `(400,450)` to commit → verify SubTotal == qty×unitPrice and a new blank row appeared
   - (next row is one row lower each iteration — re-screenshot to get the current empty-row Y)
6. **Parts lines** — click **Parts** tab `(264,254)`. Columns CONFIRMED (2026-07-06):
   **Part Number ("Part Lookup" ghost, magnifier) | Description | Cost | Qty | Unit Price |
   D% | VAT | SubTotal**. Free-text parts work with Part Number left EMPTY (Cost column then
   shows a red ✗ = no cost recorded — harmless). Cell coords on the first empty row:
   Description `(186,299)`, Qty `(858,299)`, Unit Price `(900,299)` (shifted vs Labour by the
   extra columns). Same enter-verify-commit pattern as Labour; click off at `(500,420)`.
7. **THE GATE** — read the Totals panel (right side): verify
   `SubTotal==expectedNet`, `VAT==expectedVat`, `Total==expectedTotal` to the penny.
   **Any mismatch → ABORT, do NOT Issue.** (A mismatch means a line was mis-entered — the
   whole point of itemised entry is that the total proves it.)
8. **Issue** — only if the gate passed: click Issue `(126,68)`. Verify header → `(Issued)`.
9. **Return the number** — read `n` from the header; write it to the web record as `ga4Number`.

## Abort / cleanup
- Abort before Issue = leftover unissued draft `n`. Delete it: **use `click_menu_button`** on
  Delete ▾ `(1003,68)` (this FileMaker menu button intermittently ignores a single click —
  observed twice, same coordinates, no state change between attempts — `click_menu_button`
  always sends two) → Delete Doc `(1001,108)` → confirm "Delete Record?" `(611,430)` → confirm
  "Delete Marked Line Items" `(622,435)`. Verify it's gone from Invoices In Progress (record
  count drops). If the record already navigated away and isn't visible, **Quick Search the doc
  number** (click the search field top-left, paste the number, Enter) rather than scrolling —
  found it instantly when scrolling didn't.
- GA4 assigns next = max(all docs)+1; deleting the highest draft frees that number.

## Hard rules
- **Never Issue unless the computed total matches the web total exactly.**
- **Verify every typed value** (portal cells are small — clicks miss; retry on blank).
- **Store `ga4Number` on the web record immediately after Issue**; that record is now the
  idempotency guard.
- VRM Lookup fills vehicle+customer together; mileage is separate. VAT auto-sets to T1 (20%).

## Preconditions (check before driving)
- **Mac screen must be unlocked.** When locked (`CGSSessionScreenIsLocked`), VM screenshots
  still work (prlctl framebuffer) but clicks/keys CANNOT reach GA4 — System Events reports
  0 Parallels windows ("Can't get window 1 of prl_client_app") and cliclick would hit the
  lock screen. Detect via
  `python3 -c "import Quartz; print(Quartz.CGSessionCopyCurrentDictionary().get('CGSSessionScreenIsLocked'))"`
  → stop and ask the user to unlock; do not retry blind.
- **Parallels console window must be open on the Mac** (VM can run headless after the window
  is closed). If unlocked but windowless: Parallels menu bar → Window → "Win11Manual".

## Speed (why the first run was slow, and what changed)

The 2026-07-06 dry run took several minutes for one invoice. Two separate costs, both fixed:

**1. Per-click overhead was ~700ms, paid by EVERY click/keystroke.** Each one re-derived the
Parallels window position via a fresh AppleScript call AND re-ran the full activate-verify
dance (set frontmost → sleep 200ms → verify) even when Parallels was already frontmost from
the previous action a second earlier. Measured: 714ms/click. **Fixed in the server
(2026-07-06 build):** window geometry is now cached 30s; the screen-lock check is cached 3s;
`activateParallels` fast-paths to a single ~150ms check-only call when already frontmost,
only falling into the slow retry loop when something actually stole focus. Measured after the
fix: ~220ms/click warm (3.2× faster). Needs a fresh session to load (servers don't hot-reload
— see [[ga4-write-path-status]]).

**2. A NEW `paste_field(x, y, text, selectAll?)` tool replaces the 4-call sequence** (Bash
clipboard-set → click → ctrl+a → ctrl+v) with one MCP call that does clipboard-set + click +
select-all + paste server-side. Use this for every exact-text field instead of the old
manual sequence — it's both fewer round-trips and avoids re-paying activation 3 extra times
per field.

**3. Operational guidance — don't re-verify what's already proven:**
- The expensive native-capture-crop-measure dropdown technique is for **discovering** an
  option list the first time. Once a list is confirmed (Status/Tester/Class are now all
  documented above), just count arrow-presses to the known option — no capture-crop-measure
  round trip needed each time.
- Don't screenshot after every single keystroke. Verify at natural checkpoints (end of a
  row, after a tab switch, before the totals gate) — the gate itself is the strongest
  correctness check and covers most silent failures (a scrambled/skipped field shows up as a
  wrong total).
- Prefer one longer wait over several short ones only where FileMaker is actually slow
  (tab switches, VRM Lookup, New Invoice); a plain field commit doesn't need it.

**4. Real-run learnings (2026-07-06, two live Issues: 90708 Knoller, 90709 Hammond belt).**
The per-click path is fast (~220ms warm); wall-clock was lost to avoidable friction. Fixes:
- **Registration field: ALWAYS `paste_field`, NEVER `type_text`.** Scancode typing intermittently
  drops a char in this combo field ("LP15 VZF"→"LP1 VZF", "BJ15 YTU"→"J15 YU"), forcing clear+retry
  (cost ~6 min on one reg). `paste_field` is deterministic here. (The field also eats Ctrl+V on the
  FIRST attempt sometimes — if the pasted value doesn't stick, clear via the field's `X` and paste again.)
- **Screenshot only at checkpoints, not after every field.** Enter a whole portal row
  (desc+qty+price) then ONE screenshot to verify the committed row + new blank row. Verify after:
  VRM Lookup, each committed line, each Extras dropdown, and the gate. This is the single biggest
  time saver.
- **Watch the Qty cell on portal rows** — it silently doesn't take sometimes (SubTotal stays 0.00);
  re-paste Qty and re-commit. The row SubTotal is the immediate tell.
- **Description tab is a rich-text field that fights automation:** Ctrl+A and Ctrl+V are eaten
  (Ctrl+V leaks a literal "v"); `paste_field` DOES work (retry once if it leaks); to clear use the
  **Edit menu → Select All** then Delete (keyboard select-all fails); menu **Edit → Paste** is the
  reliable fallback (needs the text on the clipboard first — `paste_field` sets it as a side effect).
  GA4 auto-Title-Cases the committed text — expected, not a failure.
- **Sundries/Lubricants/Paint & Mat.** map to the **Extras panel** (under MOT), NOT a Parts line —
  see [[ga4-sundries-placement]]. (On 90708 I used a Parts line and it still tied to the penny; Adam
  wants Extras going forward.)
- **The Issue dialog** offers Close / Issue & Print / Issue & Email / Issue Print & Email / **Issue Only**.
  Use **Issue Only** for a plain write-back (no print/email/payment — those are outward-facing).
- **Direct GA4 data-layer writes are NOT viable** (Standalone FileMaker runtime: no Data API/ODBC;
  binary file; and it would bypass GA4's number-assignment + calc logic, which must stay authoritative).
  UI automation is the correct write path. Direct/binary access is read-only (verification only).

## Coordinates
Image-space (1200-wide screenshot); the server maps them to the live window. They are stable
references but **re-screenshot to confirm the current empty-row Y** as portal rows grow.
See [[ga4-invoice-writeback]] and [[ga4-system-map]] in memory for the full mapping and
[[ga4-write-path-status]] for the input-layer fix this depends on.

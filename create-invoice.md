# create_invoice — register a web invoice into GA4, return the authoritative number

Purpose: given a completed invoice from the web app (garagemanagerpro), create it in GA4
**itemised and exact**, verify GA4's computed total matches, **Issue** it, and return the
GA4 invoice number so the web app prints the aligned number. Replaces the docNoClearance
guess-ahead scheme — GA4 becomes the single source of truth for the number.

Runs as an agent procedure over the `garage-assistant` MCP tools (screenshot + click +
type + press_key), on the HARDENED server (activate-verify-retry per click). The agent
reads the screenshot to verify each step and to read the assigned number.

## Input contract
```
{
  webInvoiceId: string,        // idempotency key (web record id)
  reg: string,                 // vehicle registration — drives VRM Lookup (vehicle + customer)
  customerAccNo: string,       // expected GA4 account no, to verify VRM Lookup pulled the right customer
  mileage: number,
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

**Exact text entry — CONFIRMED MECHANISM (use this for every text/number field):**
**clipboard-paste**, not char-by-char typing.
1. Set the VM clipboard to the exact source string:
   `prlctl exec Win11Manual --current-user powershell -Command "Set-Clipboard -Value '<exact>'"`
2. Focus the target field (click it).
3. Paste with **Ctrl+V via send-key-event** (scancodes 29+47) — NOT via `prlctl exec`
   keystrokes (those don't reach interactive GA4). The exec-set clipboard IS shared with the
   interactive session, so this pastes the exact string.
   VERIFIED 2026-07-03: pasted "PASTED_OK" into a live field intact.
This is **deterministic** — it reproduces any characters (`& + ( ) : " '`) exactly and
CANNOT scramble (unlike scancode typing, which put a Qty digit in the Description cell during
the supervised run). This is what makes field-level exactness achievable.

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

**Extras-dropdown interaction (LEARNED 2026-07-03, hardened server):**
- Click the **value box** (e.g. `(1120,565)` for MOT, `(1130,577)` for Class) — clicking the
  tiny ▼ arrow does NOT open the popup.
- The popup rows are ~6–7px tall in image space — **do not click rows**. With the popup open,
  use **arrow keys + return** (verified: up ×1 + return moved Retest→Full correctly).
- Screenshots can show a **stale popup overlay** after selection — press `escape`, click a
  neutral spot, then re-screenshot to read the committed value before judging success.
For exactness: set MOT type + Class(pricing tier) + Status + Tester + fee to match the web
app's MOT, and confirm the Totals **MOT** line equals the web app's MOT amount. Still to
enumerate on the fixed server: exact Status and Tester option lists.

## Idempotency (do FIRST, before touching GA4)
- If the web record already has a `ga4Number`, **ABORT — already registered.** Never create twice.

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
5. **Labour lines** — click **Labour** tab `(191,254)`. For each labour item, on the empty
   ("Job Lookup") row:
   - Description cell `(200,294)` → type description
   - Qty cell `(~840,294)` → type qty   ← small target; verify it landed, retry if blank
   - Unit Price cell `(~877,294)` → type unitPrice
   - click off the row `(400,450)` to commit → verify SubTotal == qty×unitPrice and a new blank row appeared
   - (next row is one row lower each iteration — re-screenshot to get the current empty-row Y)
6. **Parts lines** — click **Parts** tab `(264,254)`; same per-row pattern (Parts portal is
   analogous; confirm its columns on first run).
7. **THE GATE** — read the Totals panel (right side): verify
   `SubTotal==expectedNet`, `VAT==expectedVat`, `Total==expectedTotal` to the penny.
   **Any mismatch → ABORT, do NOT Issue.** (A mismatch means a line was mis-entered — the
   whole point of itemised entry is that the total proves it.)
8. **Issue** — only if the gate passed: click Issue `(126,68)`. Verify header → `(Issued)`.
9. **Return the number** — read `n` from the header; write it to the web record as `ga4Number`.

## Abort / cleanup
- Abort before Issue = leftover unissued draft `n`. Delete it: Delete ▾ `(1003,68)` →
  Delete Doc `(1001,108)` → confirm "Delete Record?" `(611,430)` → confirm "Delete Marked
  Line Items" `(622,435)`. Verify it's gone from Invoices In Progress.
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

## Coordinates
Image-space (1200-wide screenshot); the server maps them to the live window. They are stable
references but **re-screenshot to confirm the current empty-row Y** as portal rows grow.
See [[ga4-invoice-writeback]] and [[ga4-system-map]] in memory for the full mapping and
[[ga4-write-path-status]] for the input-layer fix this depends on.

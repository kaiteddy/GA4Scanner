# ga4-number-pool worker — LLM agent operating procedure

The worker is a Claude agent that runs on a loop **locally on the GA4 Mac** (it drives the
`garage-assistant` MCP, which controls the Parallels VM — so it CANNOT run in the cloud). Each
run does two jobs: **drain** the fill queue and **replenish** the number pool. The webapp already
hands out real GA4 numbers instantly by popping the pool (`issueDocument`→`popGa4Number`); this
worker is what makes those numbers real GA4 invoices and keeps the pool stocked.

DB: garagemanagerpro Neon (project wispy-lake-94196757), table `ga4NumberPool`. See
[[ga4-number-pool]], create-invoice.md (field coords, gate rule, MOT set), [[ga4-writeback-backlog]]
(fill_invoice reliability notes), [[customer-account-number-linkage]] (web account codes unreliable).

## Preconditions (abort the run and alert if not met)
- **Mac unlocked** — `assertScreenUnlocked` fails otherwise (clicks can't reach GA4). Do NOT retry blind.
- **GA4 open + foregrounded** — call `focus_window` first; screenshot to confirm the Invoices module.
- Config: `POOL_TARGET=20`, `POOL_REFILL_AT=8` (replenish when available < 8, up to 20).

## Job A — DRAIN the fill queue (do FIRST; these are customers waiting on a real doc)
1. `SELECT p.id, p."ga4Number", p."claimedByDocId" FROM "ga4NumberPool" p WHERE p.status='claimed' ORDER BY p."ga4Number"::bigint`.
2. For each claimed row (number **N**, doc **D**):
   a. Load D from Neon: `serviceHistory` (reg, mileage, customerName/custSurname, accountNumber,
      docType, motStatus/motClass, description, totalNet/Tax/Gross) + its `serviceLineItems`
      (itemType, description, quantity, unitPrice). Build the fill payload + the expected gate.
   b. **Open the reserved blank draft N:** Invoices module → Invoices In Progress → sort by Doc No
      descending (click the Doc No header if needed) → screenshot → find the row with Doc No = **N**
      → double-click Open. Verify header reads `Invoice: N (Not Issued)`. (Quick Search is
      unreliable for invoice numbers — it collides with Job Sheet numbers — so use the list.)
   c. `fill_invoice({ startFrom: "current", reg, mileage, labour, parts, mot?, jobDescription? })`
      — fills the OPEN draft in place (no New Invoice, so N is preserved). Double-paste is built in.
   d. Verify from the returned screenshot: (1) customer attached + name matches D's surname — if Acc
      shows "Auto Generate" (vehicle new to GA4), call `attach_customer(surname)` then re-verify;
      (2) **Totals gate == expected net/VAT/(MOT)/gross to the penny**. Watch for blank line
      descriptions (re-`paste_field` if any) and MOT line (= web MOT amount).
   e. **Only if the gate matches:** `issue_invoice`. Then
      `UPDATE "ga4NumberPool" SET status='filled', "filledAt"=now() WHERE id=<row.id>`.
      (D.ga4Number was already stamped = N at pop time — nothing to re-stamp.)
   f. **On ANY mismatch / missing customer / surprise:** do NOT issue.
      `UPDATE "ga4NumberPool" SET status='failed', attempts=attempts+1, note=<reason> WHERE id=<row.id>`
      and continue. A human completes draft N by hand; the printed number is still correct.

## Job B — REPLENISH the pool
1. `getPoolStatus()` (or `SELECT count(*) FILTER (WHERE status='available') ...`). If available ≥ REFILL_AT, done.
2. Create blank drafts until available = TARGET. For each:
   a. New Invoice (Invoices nav → New Invoice). Wait for the draft. Screenshot.
   b. **Read the assigned number** from the header `Invoice: N (Not Issued)`.
   c. (Optional but recommended) paste `WEB-RESERVED` into Order Ref so staff know not to delete it.
   d. Leave it blank & unissued (GA4 persisted the record when it assigned N — no Save needed).
   e. `INSERT INTO "ga4NumberPool" ("ga4Number") VALUES ('N') ON CONFLICT DO NOTHING`.
   f. Return Home before the next New Invoice.
   Numbers must be strictly increasing; if a New Invoice returns a number already in the pool
   (staff created one in between), that's fine — ON CONFLICT skips it.

## Job C — FALLBACK backfill (pool was empty at issue time)
Any WEB invoice issued while the pool was empty has `ga4Number IS NULL`:
`SELECT id FROM "serviceHistory" WHERE "externalId" LIKE 'WEB-%' AND "docType" IN ('SI','XS')
 AND "dateIssued" IS NOT NULL AND "ga4Number" IS NULL`.
For each: **pre-check the fresh GA4 export by reg+total** (skip if already in GA4 — stamp that
number instead), else `fill_invoice({ startFrom: "new", ... })` → verify gate → `issue_invoice`
→ read the assigned number M from the header → `UPDATE serviceHistory SET ga4Number='M' WHERE id=<id>`.

## Scheduling
Run every ~2 min via launchd on the GA4 Mac (headless `claude` with this playbook as the prompt),
mirroring the ga4-autosync watcher ([[ga4-force-sync-button]]). The NUMBER is already instant at
web-Issue, so a couple of minutes' fill latency is invisible to the customer. Alert (log + notify)
if: screen locked, pool available == 0, or any row went `failed`.

## Hard rules
- **Never `issue_invoice` unless the gate matches to the penny** (the total is the proof the lines
  are right). A wrong issued invoice is not recoverable; an unfilled reserved draft is harmless.
- **Never delete a reserved draft** — deleting frees its number for GA4 to reuse, breaking the pool.
- Trust GA4's VRM/customer over the web `accountNumber` (web codes are frequently wrong).

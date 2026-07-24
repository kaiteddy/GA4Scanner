# GA4 ↔ web-app invoice reconciliation — runbook

How the two systems stay in sync, and the daily routine for keeping them there.
Database guardrails are in [`sql/reconciliation_schema.sql`](sql/reconciliation_schema.sql)
(the authoritative copy of what is live in Neon).

## The core problem

Two systems create invoices:

- **GA4** (Garage Assistant, FileMaker desktop app) — the **legal system of record** for
  invoice numbers and VAT. It mints numbers `max+1` and **never reuses** them. No API: the only
  way in is UI automation.
- **The web app** (Neon Postgres `garagemanagerpro`, table `serviceHistory`) — where some staff
  raise invoices, and where the reminder/customer data lives.

The same job must carry the **same number in both**. GA4 won't accept a number as input, so the
web app must **reserve a real GA4 number in advance** — the "pool".

## The pool

`ga4NumberPool` is bookkeeping over **pre-created empty GA4 invoices ("blanks")**. Flow:

1. Create blank invoices in GA4 (`scripts/ga4_replenish.ps1`) → GA4 assigns real numbers.
2. Register each as `available` in `ga4NumberPool` **and** `blank` in `ga4NumberLedger`.
3. Web app **claims** one at issue time → status `claimed`, its `docNo`/`ga4Number` = that number.
4. Later, the claimed number's GA4 blank is **filled** with the invoice content
   (`scripts/ga4_fill.ps1`) and issued → pool status `filled`.

There is an inherent lag between step 3 (web issues instantly) and step 4 (GA4 blank filled on
the next sweep). That lag is **tracked** (pool status `claimed`, not `filled`) — it is not drift.

## The guardrails (why 2026-07-21 can't recur)

When the pool emptied, the web app invented numbers in GA4's range → collisions. Now, enforced
in the database so no app code can bypass them:

- **Gate A** — unique `docNo`: two invoices can never share a number.
- **Gate B** — a `ga4Number` must be real (in the ledger) and not burnt or owned elsewhere;
  claimed automatically into the ledger, and stays claimed even if the document is deleted
  (this is how 90727 was lost — a delete freed the number).
- **Gate C** — a web invoice **cannot be issued without a pool-reserved number**. Empty pool →
  the issue **fails loudly** ("no GA4 number reserved") instead of inventing one.

Numbers are burnt permanently as `state='dead'`: **90727, 90730, 90732, 90733, 90805, 90743,
90771, 90777** (the last three verified absent from GA4's Invoices/Void/Credit tabs).

## Daily routine

Run when GA4 is idle (check the data-file mtime; every script also self-checks). Early morning or
end of day is safest — GA4 is a live shared app and driving it while someone works corrupts their
open record (this happened twice to job sheet 93232).

1. **Scan for the other side's work** — invoices staff raised directly in GA4:
   `scripts/ga4_scan_new.ps1 -From <last-known-number>`
   Walks forward from the last known number, stops after N misses (safe: the sequence has no
   holes). Reports which numbers are missing from the web app.

2. **Health check** (all should be empty/clean):
   ```sql
   -- numbers that don't match between systems
   SELECT "docNo" FROM "serviceHistory"
   WHERE "ga4Number" IS NOT NULL AND "ga4Number" <> "docNo" AND "docNo" NOT LIKE 'SUPERSEDED-%';
   -- issued web invoices with no GA4 number (should be impossible now, but verify)
   SELECT "docNo" FROM "serviceHistory"
   WHERE "docType"='SI' AND "docStatus"='Issued' AND "externalId" LIKE 'WEB-%'
     AND ("ga4Number" IS NULL OR "ga4Number"='');
   -- claimed-but-not-yet-filled (the expected lag; these need filling into GA4)
   SELECT "ga4Number" FROM "ga4NumberPool" WHERE status='claimed';
   -- pool health
   SELECT * FROM "ga4PoolStatus";
   -- contiguity proof: any unexplained gap = a document we haven't captured
   SELECT n FROM generate_series(90714, (SELECT max("ga4Number")::int FROM "ga4NumberLedger")) n
   WHERE NOT EXISTS (SELECT 1 FROM "ga4NumberLedger" l WHERE l."ga4Number"=n::text);
   ```

3. **Fill the claimed web invoices into GA4** — build a work order (see `ga4_fill.ps1` header for
   the JSON shape), `ga4_fill.ps1 <wo.json>` verifies the total to the penny and stops before
   issue; issue supervised. Then mark the pool row `filled`.

4. **Align any `docNo <> ga4Number`** — set `docNo = ga4Number` (the pool number is authoritative):
   ```sql
   UPDATE "serviceHistory" h SET "docNo"=h."ga4Number"
   WHERE h.id=:id AND h."ga4Number" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "serviceHistory" x WHERE x."docNo"=h."ga4Number"
                     AND x.id<>h.id AND x."docType"='SI' AND x."docNo" NOT LIKE 'SUPERSEDED-%');
   ```

5. **Import GA4-only invoices** the scan found into the web app (header + line items, keyed by
   `ga4Number`). New customers/vehicles created directly in GA4 must be inserted too.

6. **Replenish** when `ga4PoolStatus.needs_replenish` is true:
   `scripts/ga4_replenish.ps1 -Count 15` → run the SQL it prints to register the new blanks.

## Key rules

- **GA4 is authoritative for numbers.** Always renumber the web side to match GA4, never the reverse.
- **Join on `ga4Number`, never `docNo`.** Every sync is an upsert by GA4 number.
- **Issued invoices are immutable** (VAT). A post-issue change is a Credit Note, not an edit.
- **Never fill a web draft that is still `New`** into GA4 as issued — fill it as a draft and issue
  both sides together when it's finalised (e.g. doc 420605 / 90800 Bezalel).
- **MOT reminder dates**: the due date is the new certificate expiry, not GA4's "52 weeks from
  today" default. Tested within the month before expiry preserves the anniversary (old expiry + 1yr).

## Standing follow-ups (application side, not yet done)

- Web app should **auto-replenish** below a threshold and **hard-fail** issue on empty pool
  (Gate C now enforces the fail; the app should surface it gracefully rather than error).
- **Job-sheet numbers also diverge** (GA4 JS vs web JS) with nothing guarding them — same class
  of problem, one layer down.
- The real fix is reducing double entry: the more invoicing moves to the web app, the smaller the
  GA4→web lag becomes.

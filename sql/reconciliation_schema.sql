-- ============================================================================
-- GA4 <-> web-app invoice-number reconciliation: database guardrails
--
-- Neon project garagemanagerpro (wispy-lake-94196757), table public."serviceHistory".
-- Captured 2026-07-24 from the LIVE database (pg_get_functiondef etc.), so this is the
-- authoritative copy - the objects below exist in Neon now. Kept in git so the safety net
-- can be understood, reviewed, and rebuilt if the database is ever restored.
--
-- BACKGROUND
-- GA4 (Garage Assistant, a FileMaker desktop app) is the legal system of record for invoice
-- numbers. It mints numbers as max+1 and NEVER reuses them - a deleted invoice's number is
-- burnt forever (90727, 90730, 90732, 90733 were all lost this way). The web app must reserve
-- a real GA4 number BEFORE it can show one at issue time; it does that from "ga4NumberPool",
-- which is just bookkeeping over pre-created empty GA4 invoices ("blanks").
--
-- THE BUG THESE GUARD AGAINST
-- When the pool emptied (2026-07-21 09:47) the web app did not stop - it invented its own
-- numbers (90863, 90864, 90867...) in GA4's range. GA4 later reissues those same numbers to
-- different customers => two different invoices share a number => VAT records diverge. Days of
-- manual reconciliation followed. The objects below make that impossible at the database layer,
-- so no amount of application code can reintroduce it.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. LEDGER: every GA4 number ever consumed. The source of truth for "is this
--    number real / free / burnt". documentId is ON DELETE SET NULL on purpose:
--    deleting a document must NOT release its number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ga4NumberLedger" (
  "ga4Number"  text PRIMARY KEY,
  "state"      text NOT NULL CHECK ("state" IN ('blank','issued','dead')),
  "documentId" integer REFERENCES "serviceHistory"(id) ON DELETE SET NULL,
  "consumedAt" timestamptz NOT NULL DEFAULT now(),
  "note"       text
);
--   state = 'blank'  : GA4 blank created, not yet filled/issued (claimable)
--          'issued' : a real issued invoice holds this number
--          'dead'   : permanently burnt, can never be reissued


-- ---------------------------------------------------------------------------
-- 2. GATE A: two invoices can never share a docNo. Partial unique index so the
--    SUPERSEDED-* tombstones (freed ghost rows) and blanks are exempt.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "serviceHistory_docNo_si_uniq"
  ON public."serviceHistory" USING btree ("docNo")
  WHERE (("docType")::text = 'SI'::text
     AND "docNo" IS NOT NULL
     AND ("docNo")::text <> ''::text
     AND ("docNo")::text !~~ 'SUPERSEDED-%'::text);


-- ---------------------------------------------------------------------------
-- 3. GATE B (BEFORE): validate a ga4Number assignment. Rejects burnt numbers
--    and numbers already owned by a different document. Claim happens AFTER
--    (function 4) because during BEFORE INSERT the row does not exist yet and
--    the ledger FK would fail.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_ga4_number_free()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE owner_id integer; owner_state text;
BEGIN
  IF NEW."ga4Number" IS NULL OR NEW."ga4Number" = '' THEN RETURN NEW; END IF;

  SELECT "documentId", state INTO owner_id, owner_state
  FROM "ga4NumberLedger" WHERE "ga4Number" = NEW."ga4Number";

  IF owner_state = 'dead' THEN
    RAISE EXCEPTION 'GA4 number % is permanently burnt and can never be reissued', NEW."ga4Number";
  END IF;

  IF owner_id IS NOT NULL AND owner_id <> NEW.id THEN
    RAISE EXCEPTION 'GA4 number % is already consumed by document % - numbers are never reusable',
      NEW."ga4Number", owner_id;
  END IF;

  RETURN NEW;
END $function$;


-- ---------------------------------------------------------------------------
-- 4. GATE B (AFTER): claim the number into the ledger once the row exists, so
--    it stays consumed even if the document is later deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_ga4_number()
 RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."ga4Number" IS NULL OR NEW."ga4Number" = '' THEN RETURN NULL; END IF;

  INSERT INTO "ga4NumberLedger" ("ga4Number", state, "documentId", note)
  VALUES (NEW."ga4Number",
          CASE WHEN NEW."docStatus" = 'Issued' THEN 'issued' ELSE 'blank' END,
          NEW.id, 'claimed automatically on write')
  ON CONFLICT ("ga4Number") DO UPDATE
    SET "documentId" = EXCLUDED."documentId",
        state        = EXCLUDED.state
    WHERE "ga4NumberLedger".state <> 'dead'
      AND ("ga4NumberLedger"."documentId" IS NULL
           OR "ga4NumberLedger"."documentId" = EXCLUDED."documentId");

  RETURN NULL;
END $function$;


-- ---------------------------------------------------------------------------
-- 5. GATE C (BEFORE): refuse to ISSUE a web-originated invoice unless it carries
--    a real, pool-reserved GA4 number. This is the direct fix for the 2026-07-21
--    incident - fail loudly instead of inventing a number. Legacy GA4 imports
--    (non-WEB- externalIds) and job sheets are untouched.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_issued_has_real_ga4_number()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE avail integer;
BEGIN
  IF NEW."docType" <> 'SI' THEN RETURN NEW; END IF;
  IF NEW."docStatus" IS DISTINCT FROM 'Issued' THEN RETURN NEW; END IF;
  IF NEW."externalId" IS NULL OR NEW."externalId" NOT LIKE 'WEB-%' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD."docStatus" = 'Issued' THEN RETURN NEW; END IF;

  IF NEW."ga4Number" IS NULL OR NEW."ga4Number" = '' THEN
    SELECT count(*) INTO avail FROM "ga4NumberPool" WHERE status = 'available';
    RAISE EXCEPTION
      'Cannot issue invoice: no GA4 number reserved. % number(s) currently available in the pool. Claim one from ga4NumberPool before issuing - do NOT allocate a docNo yourself, it will collide with a real GA4 invoice.',
      avail;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "ga4NumberLedger" WHERE "ga4Number" = NEW."ga4Number") THEN
    RAISE EXCEPTION
      'Cannot issue invoice: ga4Number % is not a real GA4 number (not in ga4NumberLedger). Numbers must come from the pool, never be invented.',
      NEW."ga4Number";
  END IF;

  RETURN NEW;
END $function$;


-- ---------------------------------------------------------------------------
-- 6. TRIGGERS wiring the functions to the table.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS "serviceHistory_ga4_number_gate" ON public."serviceHistory";
CREATE TRIGGER "serviceHistory_ga4_number_gate"
  BEFORE INSERT OR UPDATE OF "ga4Number" ON public."serviceHistory"
  FOR EACH ROW EXECUTE FUNCTION assert_ga4_number_free();

DROP TRIGGER IF EXISTS "serviceHistory_ga4_number_claim" ON public."serviceHistory";
CREATE TRIGGER "serviceHistory_ga4_number_claim"
  AFTER INSERT OR UPDATE OF "ga4Number" ON public."serviceHistory"
  FOR EACH ROW EXECUTE FUNCTION claim_ga4_number();

DROP TRIGGER IF EXISTS "serviceHistory_issue_requires_pool_number" ON public."serviceHistory";
CREATE TRIGGER "serviceHistory_issue_requires_pool_number"
  BEFORE INSERT OR UPDATE ON public."serviceHistory"
  FOR EACH ROW EXECUTE FUNCTION assert_issued_has_real_ga4_number();


-- ---------------------------------------------------------------------------
-- 7. POOL STATUS view: one-line "am I low?" check. needs_replenish flips true
--    below 10 available; suggested_top_up targets a depth of 30.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "ga4PoolStatus" AS
 SELECT count(*) FILTER (WHERE status::text = 'available'::text) AS available,
        count(*) FILTER (WHERE status::text = 'claimed'::text)   AS claimed,
        (SELECT max("ga4Number") FROM "ga4NumberLedger")         AS ga4_highest_known,
        count(*) FILTER (WHERE status::text = 'available'::text) < 10 AS needs_replenish,
        GREATEST(0::bigint, 30 - count(*) FILTER (WHERE status::text = 'available'::text)) AS suggested_top_up
   FROM "ga4NumberPool";

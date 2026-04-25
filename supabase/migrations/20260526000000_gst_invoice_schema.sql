-- ════════════════════════════════════════════════════════════════════════════
-- Migration: GST invoice schema (Phase 1.3.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Adds the schema needed to issue Indian GST tax invoices for paid
-- subscriptions:
--   - Customer-side fields on `fleets` (GSTIN, billing address, state code)
--   - `invoice_counters` table + `next_invoice_number()` for gapless,
--     FY-scoped sequential numbering as required by GST law
--   - `indian_fy_label()` helper for the April–March financial year
--   - `invoices` table — denormalized customer + supplier snapshots so the
--     invoice never silently changes if either party updates their details
--
-- Dormant-mode design: the supplier (us) is not yet GST-registered. The
-- razorpay-webhook still issues invoices for every charge — they just record
-- `is_dormant_supplier = true` and zero-out the tax columns. The day SUPPLIER_*
-- env vars are set, future invoices flip to live tax computation; pre-existing
-- dormant rows are left as-is for the audit trail.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets table)
--   - 20260501000000_subscription_system_v2.sql           (subscriptions table)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Customer billing details on `fleets` ─────────────────────────────────

ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS gstin            TEXT,
  ADD COLUMN IF NOT EXISTS billing_address  TEXT,
  ADD COLUMN IF NOT EXISTS state_code       TEXT;

-- GSTIN is 15 chars: 2-digit state code + 10-char PAN + 1-char entity +
-- 1-char alphabet ('Z' for normal taxpayers) + 1-char checksum.
-- The CHECK is intentionally permissive — we validate the precise format
-- client-side; the DB only blocks lengths that are obviously wrong.
ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_gstin_format;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_gstin_format
  CHECK (gstin IS NULL OR char_length(gstin) = 15);

ALTER TABLE fleets
  DROP CONSTRAINT IF EXISTS fleets_state_code_format;
ALTER TABLE fleets
  ADD  CONSTRAINT fleets_state_code_format
  CHECK (state_code IS NULL OR state_code ~ '^[0-9]{2}$');

COMMENT ON COLUMN fleets.gstin IS
  'Customer GSTIN. Required for B2B input-tax-credit eligibility; NULL is '
  'allowed for unregistered B2C customers. Validated by client (regex) and '
  'length-checked here.';
COMMENT ON COLUMN fleets.billing_address IS
  'Single-string billing address printed on invoices. We deliberately keep '
  'this unstructured — invoice display uses it verbatim.';
COMMENT ON COLUMN fleets.state_code IS
  '2-digit GST state code (e.g. ''33'' for Tamil Nadu, ''29'' for Karnataka). '
  'Drives intra-state vs inter-state tax split (CGST+SGST vs IGST). Must '
  'match the first 2 chars of `gstin` when both are set.';


-- ── 2. Invoice counter (gapless, per-FY) ────────────────────────────────────
-- GST law requires a single monotonic sequence across the whole business per
-- financial year — not per customer. Atomicity is provided by the unique key
-- + ON CONFLICT inside `next_invoice_number()` below.

CREATE TABLE IF NOT EXISTS invoice_counters (
  fy_label    TEXT PRIMARY KEY,                              -- e.g. '2026-27'
  last_seq    INTEGER NOT NULL DEFAULT 0,                    -- highest seq assigned so far
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE invoice_counters IS
  'Per-FY counter for gapless invoice numbering. One row per Indian FY '
  '(April–March). Updated atomically by next_invoice_number().';


-- ── 3. Helper: derive Indian FY label from a date ───────────────────────────

CREATE OR REPLACE FUNCTION indian_fy_label(p_date TIMESTAMPTZ DEFAULT now())
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year       INTEGER := extract(year  from p_date)::int;
  v_month      INTEGER := extract(month from p_date)::int;
  v_start_year INTEGER;
BEGIN
  -- Indian FY runs Apr 1 (current year) → Mar 31 (next year).
  IF v_month >= 4 THEN
    v_start_year := v_year;
  ELSE
    v_start_year := v_year - 1;
  END IF;
  RETURN v_start_year::text
      || '-'
      || lpad(((v_start_year + 1) % 100)::text, 2, '0');
END;
$$;

COMMENT ON FUNCTION indian_fy_label(TIMESTAMPTZ) IS
  'Returns ''YYYY-YY'' for the Indian financial year containing the given '
  'timestamp. Apr 2026 → ''2026-27''; Mar 2027 → ''2026-27''; Apr 2027 → '
  '''2027-28''.';


-- ── 4. Helper: allocate the next invoice number ─────────────────────────────
-- Atomic INSERT ... ON CONFLICT ... DO UPDATE returns the post-update
-- last_seq, which is the sequence number to use on this invoice.

CREATE OR REPLACE FUNCTION next_invoice_number(
  p_fy_label TEXT,
  p_prefix   TEXT DEFAULT 'FTP'
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  INSERT INTO invoice_counters AS c (fy_label, last_seq, updated_at)
  VALUES (p_fy_label, 1, now())
  ON CONFLICT (fy_label)
  DO UPDATE SET last_seq   = c.last_seq + 1,
                updated_at = now()
  RETURNING last_seq INTO v_seq;

  -- 5-digit zero-padded gives us 99,999 invoices per FY before format change.
  -- At ~1 invoice per fleet per month, that's headroom for ~8,000 fleets.
  RETURN p_prefix || '/' || p_fy_label || '/' || lpad(v_seq::text, 5, '0');
END;
$$;

COMMENT ON FUNCTION next_invoice_number(TEXT, TEXT) IS
  'Atomically allocates and returns the next invoice number for the given '
  'FY (e.g. ''FTP/2026-27/00001''). Call inside the same transaction as the '
  'INSERT into `invoices` so a rolled-back insert does not waste a number.';


-- ── 5. Invoices table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number           TEXT NOT NULL UNIQUE,
  fleet_id                 uuid NOT NULL REFERENCES fleets(id)         ON DELETE RESTRICT,
  subscription_id          uuid          REFERENCES subscriptions(id)  ON DELETE SET NULL,

  -- ── Customer snapshot (frozen at issue time) ──────────────────────────────
  -- Denormalized so an invoice never changes if the fleet edits its address
  -- or GSTIN later — mandatory under GST audit rules.
  customer_name            TEXT NOT NULL,
  customer_gstin           TEXT,
  customer_address         TEXT,
  customer_state_code      TEXT,

  -- ── Supplier snapshot (frozen at issue time) ──────────────────────────────
  supplier_name            TEXT NOT NULL,
  supplier_gstin           TEXT,                                       -- NULL during dormant mode
  supplier_address         TEXT NOT NULL,
  supplier_state_code      TEXT NOT NULL,

  -- ── Line item ─────────────────────────────────────────────────────────────
  description              TEXT NOT NULL,                              -- e.g. "Professional plan — 5 vehicles, monthly"
  hsn_sac                  TEXT NOT NULL DEFAULT '998314',             -- IT infra provisioning (B2B SaaS)
  quantity                 INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_inr           NUMERIC(12,2) NOT NULL,
  taxable_amount_inr       NUMERIC(12,2) NOT NULL,                     -- pre-tax base

  -- ── Tax breakdown ─────────────────────────────────────────────────────────
  -- Either (cgst + sgst) is non-zero (intra-state) OR igst is non-zero
  -- (inter-state), never both. All zero in dormant mode.
  cgst_pct                 NUMERIC(5,2)  NOT NULL DEFAULT 0,
  cgst_amount_inr          NUMERIC(12,2) NOT NULL DEFAULT 0,
  sgst_pct                 NUMERIC(5,2)  NOT NULL DEFAULT 0,
  sgst_amount_inr          NUMERIC(12,2) NOT NULL DEFAULT 0,
  igst_pct                 NUMERIC(5,2)  NOT NULL DEFAULT 0,
  igst_amount_inr          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inr                NUMERIC(12,2) NOT NULL,

  -- ── Razorpay refs (nullable for manual / off-platform invoices) ──────────
  razorpay_payment_id      TEXT,
  razorpay_subscription_id TEXT,
  razorpay_invoice_id      TEXT,

  -- ── Status ────────────────────────────────────────────────────────────────
  status                   TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('draft', 'issued', 'cancelled')),
  is_dormant_supplier      BOOLEAN NOT NULL DEFAULT false,             -- true ⇒ supplier_gstin was unset

  invoice_date             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ── Consistency constraints ───────────────────────────────────────────────
  -- Intra-state and inter-state are mutually exclusive.
  CONSTRAINT invoices_tax_split_consistent CHECK (
    (cgst_amount_inr = 0 AND sgst_amount_inr = 0)
    OR igst_amount_inr = 0
  ),
  -- Dormant invoices carry no tax components.
  CONSTRAINT invoices_dormant_no_tax CHECK (
    NOT is_dormant_supplier
    OR (cgst_amount_inr = 0 AND sgst_amount_inr = 0 AND igst_amount_inr = 0
        AND cgst_pct    = 0 AND sgst_pct        = 0 AND igst_pct        = 0)
  ),
  -- Total = taxable + all taxes (within rounding tolerance).
  CONSTRAINT invoices_total_matches CHECK (
    abs(total_inr - (taxable_amount_inr + cgst_amount_inr + sgst_amount_inr + igst_amount_inr)) <= 0.02
  )
);

CREATE INDEX IF NOT EXISTS invoices_fleet_id_idx     ON invoices (fleet_id);
CREATE INDEX IF NOT EXISTS invoices_invoice_date_idx ON invoices (invoice_date DESC);
CREATE INDEX IF NOT EXISTS invoices_subscription_idx ON invoices (subscription_id);

-- Idempotency: a single Razorpay payment can map to at most one invoice.
-- Razorpay redelivers webhooks aggressively (their docs commit only to
-- "at-least-once"), so the webhook handler relies on this partial unique
-- index + ON CONFLICT DO NOTHING to make insertion safely retriable.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_razorpay_payment_id_unique
  ON invoices (razorpay_payment_id)
  WHERE razorpay_payment_id IS NOT NULL;

COMMENT ON TABLE invoices IS
  'Indian GST tax invoices issued for paid subscription charges. Records are '
  'append-only — never UPDATE customer/supplier snapshots; issue a new '
  'corrective invoice (or status=''cancelled'') if details change. See '
  'razorpay-webhook for the issuance path.';


-- ── 6. RLS — fleet managers can read their own invoices ─────────────────────

ALTER TABLE invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read own fleet invoices" ON invoices;
CREATE POLICY "managers read own fleet invoices" ON invoices
  FOR SELECT
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

-- Counters are server-side bookkeeping; no user-facing reads or writes.
DROP POLICY IF EXISTS "no client access to invoice counters" ON invoice_counters;
CREATE POLICY "no client access to invoice counters" ON invoice_counters
  FOR ALL
  USING (false);

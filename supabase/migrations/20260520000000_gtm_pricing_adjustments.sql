-- ════════════════════════════════════════════════════════════════════════════
-- Migration: GTM pricing adjustments (Phase 1.2.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Align per-vehicle prices and min_vehicles floors with the approved South-
-- India GTM catalog, and add columns for the pre-created Razorpay plan IDs
-- used by the checkout flow (Phase 1.2.4).
--
-- Depends on:
--   - 20260515000000_per_vehicle_plans.sql (plan_definitions schema + seed)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Update per-vehicle prices + min_vehicles floors ──────────────────────
-- Prices are per vehicle per month in INR.
-- Essential / Professional / Business all use billing_model = 'per_vehicle'.
-- Enterprise stays 'custom' (min_vehicles = 50, price negotiated).

UPDATE plan_definitions
SET price_per_vehicle_inr = 300,
    min_vehicles          = 1,
    updated_at            = now()
WHERE plan_name = 'essential';

UPDATE plan_definitions
SET price_per_vehicle_inr = 1500,
    min_vehicles          = 5,
    updated_at            = now()
WHERE plan_name = 'professional';

UPDATE plan_definitions
SET price_per_vehicle_inr = 3000,
    min_vehicles          = 10,
    updated_at            = now()
WHERE plan_name = 'business';

-- Enterprise: reaffirm min_vehicles = 50 (in case a prior migration set a
-- different value); price remains NULL because billing_model = 'custom'.
UPDATE plan_definitions
SET min_vehicles = 50,
    updated_at   = now()
WHERE plan_name = 'enterprise';


-- ── 2. Store annual-billing discount as a column (not a hardcoded constant) ─

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS annual_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 20.00
    CHECK (annual_discount_pct >= 0 AND annual_discount_pct <= 100);

COMMENT ON COLUMN plan_definitions.annual_discount_pct IS
  'Flat percentage discount applied to annual billing vs monthly. '
  'Ops can adjust without a code deploy.';


-- ── 3. Pre-created Razorpay plan IDs ────────────────────────────────────────
-- Populated by a one-shot provisioning script in Phase 1.2.4.
-- One plan per (plan_name, billing_cycle) tuple; quantity = vehicle_count
-- is set at subscription creation time so a single Razorpay plan serves all
-- customer sizes (D5a).

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS razorpay_monthly_plan_id TEXT;

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS razorpay_annual_plan_id TEXT;

COMMENT ON COLUMN plan_definitions.razorpay_monthly_plan_id IS
  'Razorpay plan_id for monthly billing. Amount = price_per_vehicle_inr * 100 (paise). '
  'Subscription sets quantity = vehicle_count. NULL for enterprise (custom pricing).';
COMMENT ON COLUMN plan_definitions.razorpay_annual_plan_id IS
  'Razorpay plan_id for annual billing. Amount = price_per_vehicle_inr * 12 * (1 - annual_discount_pct/100) * 100 (paise). '
  'Subscription sets quantity = vehicle_count. NULL for enterprise (custom pricing).';

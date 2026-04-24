-- ═══════════════════════════════════════════════════════════════════════════
-- PER-VEHICLE SUBSCRIPTION MODEL — Phase 1.1
--
-- Introduces new per-vehicle pricing tiers (Essential / Professional /
-- Business) designed for the South India GTM. Existing flat-tier plans
-- (starter / growth / pro) are marked inactive but preserved for audit
-- trail. Trial plan kept unchanged. Enterprise row is updated in-place:
-- 50-vehicle minimum, custom pricing, public on pricing page with
-- "Contact Sales" CTA.
--
-- Also updates fn_check_geofence_zone_limit() to handle new plan names so
-- that Essential / Professional / Business customers get correct zone
-- quotas (instead of falling through to the 2-zone free-tier default).
--
-- Dependencies:
--   - plan_definitions, subscriptions tables (from 20260501000000)
--   - check_vehicle_limit RPC              (from 20260502000000)
--   - fn_check_geofence_zone_limit         (from 20260510000000)
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Extend plan_definitions with per-vehicle model support ────────────────

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS price_per_vehicle_inr INTEGER;

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS billing_model TEXT NOT NULL DEFAULT 'flat'
    CHECK (billing_model IN ('flat', 'per_vehicle', 'custom'));

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS min_vehicles INTEGER NOT NULL DEFAULT 1;

ALTER TABLE plan_definitions
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN plan_definitions.billing_model IS
  'flat = price_inr as-is (legacy); per_vehicle = price_per_vehicle_inr * vehicle_count; custom = negotiated (Enterprise)';
COMMENT ON COLUMN plan_definitions.min_vehicles IS
  'Minimum vehicle count required to select this plan; enforced client-side on pricing page';


-- ── 2. Mark old flat-tier plans inactive (audit trail preserved) ─────────────

UPDATE plan_definitions
SET is_active  = false,
    updated_at = now()
WHERE plan_name IN ('starter', 'growth', 'pro');


-- ── 3. Update enterprise plan in-place for GTM ───────────────────────────────

UPDATE plan_definitions
SET display_name          = 'Enterprise',
    billing_model         = 'custom',
    price_per_vehicle_inr = NULL,
    price_inr             = 0,           -- custom pricing, negotiated
    min_vehicles          = 50,
    vehicle_limit         = -1,          -- unlimited
    driver_limit          = -1,
    is_public             = true,        -- show on pricing page with Contact Sales CTA
    is_active             = true,
    sort_order            = 40,
    updated_at            = now()
WHERE plan_name = 'enterprise';


-- ── 4. Insert 3 new per-vehicle plans ────────────────────────────────────────

INSERT INTO plan_definitions (
  plan_name, display_name,
  price_inr, price_per_vehicle_inr, billing_model,
  min_vehicles, vehicle_limit, driver_limit, trial_days,
  feature_flags, is_public, sort_order, is_active
)
VALUES
  -- Essential: ₹299 per vehicle per month, minimum 1 vehicle
  ('essential', 'Essential',
   0, 299, 'per_vehicle',
   1, -1, -1, 0,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "driver_behavior":       false,
     "maintenance_alerts":    false,
     "cost_analytics":        false,
     "multi_user":            false,
     "ai_prediction":         false,
     "fuel_theft_detection":  false,
     "api_access":            false,
     "custom_reports":        false,
     "priority_support":      false
   }'::jsonb,
   true, 10, true),

  -- Professional: ₹499 per vehicle per month, minimum 3 vehicles
  ('professional', 'Professional',
   0, 499, 'per_vehicle',
   3, -1, -1, 0,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "driver_behavior":       "full",
     "maintenance_alerts":    "full",
     "cost_analytics":        "full",
     "multi_user":            "full",
     "ai_prediction":         false,
     "fuel_theft_detection":  false,
     "api_access":            false,
     "custom_reports":        false,
     "priority_support":      false
   }'::jsonb,
   true, 20, true),

  -- Business: ₹799 per vehicle per month, minimum 10 vehicles
  ('business', 'Business',
   0, 799, 'per_vehicle',
   10, -1, -1, 0,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "driver_behavior":       "full",
     "maintenance_alerts":    "full",
     "cost_analytics":        "full",
     "multi_user":            "full",
     "ai_prediction":         "full",
     "fuel_theft_detection":  "full",
     "api_access":            "full",
     "custom_reports":        "full",
     "priority_support":      "full"
   }'::jsonb,
   true, 30, true)

ON CONFLICT (plan_name) DO NOTHING;


-- ── 5. Extend subscriptions with per-vehicle + billing fields ────────────────

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_model TEXT NOT NULL DEFAULT 'flat'
    CHECK (billing_model IN ('flat', 'per_vehicle', 'custom'));

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS price_per_vehicle_inr INTEGER;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS vehicle_count INTEGER;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS gstin TEXT;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS annual_unlocked_at TIMESTAMPTZ;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_cycle TEXT DEFAULT 'monthly'
    CHECK (billing_cycle IN ('monthly', 'annual'));

COMMENT ON COLUMN subscriptions.vehicle_count IS
  'Paid-for vehicle quota under per_vehicle billing. Separate from actual vehicles.count.';
COMMENT ON COLUMN subscriptions.price_per_vehicle_inr IS
  'Per-vehicle price locked at subscribe time (protects customer from future price changes)';
COMMENT ON COLUMN subscriptions.annual_unlocked_at IS
  'Set when subscription crosses 3-month active mark. Annual billing toggle enabled when not null.';
COMMENT ON COLUMN subscriptions.gstin IS
  'Customer GSTIN (15 chars) used for GST-compliant invoice generation. Optional.';


-- ── 6. Relax subscriptions.plan CHECK to include new plan names ──────────────

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
    CHECK (plan IN (
      'trial', 'starter', 'growth', 'pro', 'enterprise',
      'essential', 'professional', 'business'
    ));


-- ── 7. Update check_vehicle_limit RPC to support all 3 billing models ────────

CREATE OR REPLACE FUNCTION check_vehicle_limit(p_fleet_id UUID)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  sub_row         RECORD;
  pd_row          RECORD;
  current_count   INTEGER;
  effective_limit INTEGER;
BEGIN
  SELECT * INTO sub_row FROM subscriptions WHERE fleet_id = p_fleet_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'no_subscription',
      'limit',   0,     'used',   0,     'plan', null
    );
  END IF;

  -- Hard blocks: suspended or expired-past-grace = no adds
  IF sub_row.status = 'suspended' THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'suspended',
      'limit',   0,     'used',   0,     'plan', sub_row.plan
    );
  END IF;

  IF sub_row.status = 'expired'
     AND (sub_row.grace_period_end IS NULL OR sub_row.grace_period_end < now())
  THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'expired_past_grace',
      'limit',   0,     'used',   0,     'plan', sub_row.plan
    );
  END IF;

  SELECT * INTO pd_row FROM plan_definitions WHERE plan_name = sub_row.plan;

  SELECT COUNT(*) INTO current_count FROM vehicles WHERE fleet_id = p_fleet_id;

  -- Per-vehicle model: quota is what customer paid for
  IF sub_row.billing_model = 'per_vehicle' THEN
    effective_limit := COALESCE(sub_row.vehicle_count, 0);

  -- Custom (Enterprise): admin override or unlimited
  ELSIF sub_row.billing_model = 'custom' THEN
    effective_limit := COALESCE(sub_row.max_vehicles, pd_row.vehicle_limit, -1);

  -- Flat model (trial + legacy): existing behaviour
  ELSE
    effective_limit := COALESCE(sub_row.max_vehicles, pd_row.vehicle_limit, 2);
  END IF;

  -- -1 means unlimited
  IF effective_limit = -1 THEN
    RETURN jsonb_build_object(
      'allowed', true,  'reason', 'unlimited',
      'limit',  -1,     'used',   current_count, 'plan', sub_row.plan
    );
  END IF;

  IF current_count >= effective_limit THEN
    RETURN jsonb_build_object(
      'allowed', false, 'reason', 'limit_reached',
      'limit',   effective_limit, 'used', current_count, 'plan', sub_row.plan
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,  'reason', 'within_limit',
    'limit',   effective_limit, 'used', current_count, 'plan', sub_row.plan
  );
END;
$$;


-- ── 8. Update geofence zone limit function to handle new plans ───────────────

CREATE OR REPLACE FUNCTION fn_check_geofence_zone_limit()
RETURNS TRIGGER AS $$
DECLARE
  current_count INTEGER;
  max_allowed   INTEGER;
  fleet_plan    TEXT;
BEGIN
  -- Get the plan for this geofence's fleet
  SELECT COALESCE(s.plan, 'trial')
    INTO fleet_plan
  FROM subscriptions s
  WHERE s.fleet_id = NEW.fleet_id;

  -- Zone quota per plan
  max_allowed := CASE fleet_plan
    -- New per-vehicle plans
    WHEN 'enterprise'   THEN 999999
    WHEN 'business'     THEN 999999
    WHEN 'professional' THEN 25
    WHEN 'essential'    THEN 10
    -- Legacy plans (kept for grandfathered subscriptions if any)
    WHEN 'pro'          THEN 999999
    WHEN 'growth'       THEN 25
    WHEN 'starter'      THEN 10
    ELSE 2   -- trial / unknown
  END;

  -- Count existing zones for this fleet
  SELECT COUNT(*) INTO current_count
  FROM geofences
  WHERE fleet_id = NEW.fleet_id;

  IF current_count >= max_allowed THEN
    RAISE EXCEPTION 'Geofence zone limit reached for plan % (% of % used)',
      fleet_plan, current_count, max_allowed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ── 9. Table comment for future maintainers ──────────────────────────────────

COMMENT ON TABLE plan_definitions IS
  'Subscription plan catalog. Three billing_model values: '
  'flat (price_inr as-is, legacy); '
  'per_vehicle (price_per_vehicle_inr * vehicle_count); '
  'custom (Enterprise, price negotiated per-customer).';

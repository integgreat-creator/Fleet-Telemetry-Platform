-- ═══════════════════════════════════════════════════════════════════════════
-- SUBSCRIPTION SYSTEM V2
-- Introduces: trial/growth plans, plan_definitions table, vehicle-limit &
-- feature-access enforcement functions, trial auto-expiry via pg_cron,
-- realtime subscription-change notification, platform admin override RPC.
--
-- Safe to run on existing data:
--   • All 'free' subscriptions are renamed to 'trial'
--   • All existing limits (max_vehicles=3 → 2) are updated to match spec
--   • All changes are additive or guarded with IF NOT EXISTS / DO blocks
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Expand plan & status CHECK constraints ────────────────────────────────

-- Rename all existing 'free' rows → 'trial' FIRST, before the constraint is
-- re-added. Adding the constraint while 'free' rows exist causes a violation.
UPDATE subscriptions
SET
  plan         = 'trial',
  max_vehicles = 2,
  max_drivers  = 3,
  updated_at   = now()
WHERE plan = 'free';

-- Drop old plan check and replace with full set including 'trial' and 'growth'
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('trial', 'starter', 'growth', 'pro', 'enterprise'));

-- Drop old status check and add 'expired'
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active', 'inactive', 'suspended', 'trial', 'expired'));

-- Fix the DEFAULT on the plan column
ALTER TABLE subscriptions
  ALTER COLUMN plan SET DEFAULT 'trial';

-- Fix the DEFAULT on max_vehicles / max_drivers to match trial spec
ALTER TABLE subscriptions
  ALTER COLUMN max_vehicles SET DEFAULT 2;

ALTER TABLE subscriptions
  ALTER COLUMN max_drivers SET DEFAULT 3;


-- ── 2. New helper columns on subscriptions ───────────────────────────────────

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS grace_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS downgrade_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS downgrade_to     TEXT
    CHECK (downgrade_to IN ('trial','starter','growth','pro','enterprise'));


-- ── 3. plan_definitions — single source of truth for limits & feature flags ──

CREATE TABLE IF NOT EXISTS plan_definitions (
  plan_name         TEXT        PRIMARY KEY
                      CHECK (plan_name IN ('trial','starter','growth','pro','enterprise')),
  display_name      TEXT        NOT NULL,
  price_inr         INTEGER     NOT NULL DEFAULT 0,   -- -1 = contact sales
  billing_cycle     TEXT        NOT NULL DEFAULT 'monthly',
  vehicle_limit     INTEGER     NOT NULL,              -- -1 = unlimited
  driver_limit      INTEGER     NOT NULL,              -- -1 = unlimited
  trial_days        INTEGER,                           -- NULL = no expiry
  feature_flags     JSONB       NOT NULL DEFAULT '{}',
  is_public         BOOLEAN     NOT NULL DEFAULT TRUE, -- FALSE = enterprise
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Public read (pricing is not a secret)
ALTER TABLE plan_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "plan_defs_public_read" ON plan_definitions;
CREATE POLICY "plan_defs_public_read"
  ON plan_definitions FOR SELECT
  USING (TRUE);

-- ── Seed plan definitions ────────────────────────────────────────────────────

INSERT INTO plan_definitions
  (plan_name, display_name, price_inr, billing_cycle, vehicle_limit, driver_limit,
   trial_days, feature_flags, is_public, sort_order)
VALUES

  -- Trial
  ('trial', 'Trial', 0, 'none', 2, 3, 30,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "limited",
     "driver_behavior":       "limited",
     "maintenance_alerts":    false,
     "cost_analytics":        false,
     "idle_detection":        "limited",
     "overspeed_alerts":      "full",
     "ai_prediction":         false,
     "fuel_theft_detection":  false,
     "multi_user":            false,
     "api_access":            false,
     "custom_reports":        false,
     "priority_support":      false
   }'::jsonb, TRUE, 1),

  -- Starter
  ('starter', 'Starter', 999, 'monthly', 2, 5, NULL,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "driver_behavior":       "limited",
     "maintenance_alerts":    false,
     "cost_analytics":        false,
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "ai_prediction":         false,
     "fuel_theft_detection":  false,
     "multi_user":            false,
     "api_access":            false,
     "custom_reports":        false,
     "priority_support":      false
   }'::jsonb, TRUE, 2),

  -- Growth
  ('growth', 'Growth', 1999, 'monthly', 5, 15, NULL,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "driver_behavior":       "full",
     "maintenance_alerts":    "full",
     "cost_analytics":        "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "ai_prediction":         "limited",
     "fuel_theft_detection":  false,
     "multi_user":            "full",
     "api_access":            false,
     "custom_reports":        false,
     "priority_support":      false
   }'::jsonb, TRUE, 3),

  -- Pro
  ('pro', 'Pro', 4999, 'monthly', 15, 50, NULL,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "driver_behavior":       "full",
     "maintenance_alerts":    "full",
     "cost_analytics":        "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "ai_prediction":         "full",
     "fuel_theft_detection":  "full",
     "multi_user":            "full",
     "api_access":            "full",
     "custom_reports":        "full",
     "priority_support":      "full"
   }'::jsonb, TRUE, 4),

  -- Enterprise
  ('enterprise', 'Enterprise', -1, 'custom', -1, -1, NULL,
   '{
     "live_tracking":         "full",
     "trip_history":          "full",
     "vehicle_status":        "full",
     "basic_reports":         "full",
     "fuel_monitoring":       "full",
     "driver_behavior":       "full",
     "maintenance_alerts":    "full",
     "cost_analytics":        "full",
     "idle_detection":        "full",
     "overspeed_alerts":      "full",
     "ai_prediction":         "full",
     "fuel_theft_detection":  "full",
     "multi_user":            "full",
     "api_access":            "full",
     "custom_reports":        "full",
     "priority_support":      "full"
   }'::jsonb, FALSE, 5)

ON CONFLICT (plan_name) DO UPDATE
  SET display_name  = EXCLUDED.display_name,
      price_inr     = EXCLUDED.price_inr,
      vehicle_limit = EXCLUDED.vehicle_limit,
      driver_limit  = EXCLUDED.driver_limit,
      feature_flags = EXCLUDED.feature_flags,
      is_public     = EXCLUDED.is_public,
      sort_order    = EXCLUDED.sort_order,
      updated_at    = now();


-- ── 4. Update fn_create_fleet_subscription to use new trial defaults ─────────

CREATE OR REPLACE FUNCTION fn_create_fleet_subscription()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO subscriptions
    (fleet_id, plan, status, max_vehicles, max_drivers, trial_ends_at)
  VALUES
    (NEW.id, 'trial', 'trial', 2, 3, now() + INTERVAL '30 days')
  ON CONFLICT (fleet_id) DO NOTHING;
  RETURN NEW;
END;
$$;


-- ── 5. check_vehicle_limit — called before every vehicle INSERT ───────────────
--
-- Returns JSONB:
--   { allowed: bool, reason?: text, limit: int, used: int, plan: text }

CREATE OR REPLACE FUNCTION check_vehicle_limit(p_fleet_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_plan         TEXT;
  v_status       TEXT;
  v_grace        TIMESTAMPTZ;
  v_max_vehicles INTEGER;
  v_plan_limit   INTEGER;
  v_used         INTEGER;
  v_effective    INTEGER;
BEGIN
  -- Pull subscription row
  SELECT s.plan, s.status, s.grace_period_end, s.max_vehicles
  INTO   v_plan, v_status, v_grace, v_max_vehicles
  FROM   subscriptions s
  WHERE  s.fleet_id = p_fleet_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  'No subscription found for this fleet. Please contact support.'
    );
  END IF;

  -- Hard block: suspended
  IF v_status = 'suspended' THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  'Your account is suspended. Please contact support.'
    );
  END IF;

  -- Hard block: expired beyond grace period
  IF v_status = 'expired'
     AND (v_grace IS NULL OR v_grace < now()) THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  'Your subscription has expired. Please renew to add vehicles.'
    );
  END IF;

  -- Get the plan's default vehicle limit
  SELECT vehicle_limit
  INTO   v_plan_limit
  FROM   plan_definitions
  WHERE  plan_name = v_plan;

  -- Effective limit: subscription-level override takes precedence over plan default
  -- -1 means unlimited (Enterprise custom)
  v_effective := COALESCE(v_max_vehicles, v_plan_limit, 2);

  IF v_effective < 0 THEN
    -- Unlimited
    RETURN jsonb_build_object(
      'allowed', true,
      'limit',   -1,
      'used',    0,
      'plan',    v_plan
    );
  END IF;

  -- Count current vehicles for this fleet
  SELECT COUNT(*) INTO v_used
  FROM   vehicles
  WHERE  fleet_id = p_fleet_id;

  IF v_used >= v_effective THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  format(
        'Vehicle limit reached (%s/%s). Upgrade your plan to add more.',
        v_used, v_effective
      ),
      'limit',   v_effective,
      'used',    v_used,
      'plan',    v_plan
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'limit',   v_effective,
    'used',    v_used,
    'plan',    v_plan
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_vehicle_limit(UUID) TO authenticated;


-- ── 6. check_feature_access — called before any gated feature ────────────────
--
-- Returns JSONB:
--   { allowed: bool, level: 'full'|'limited'|'none', plan: text, reason?: text }

CREATE OR REPLACE FUNCTION check_feature_access(p_fleet_id UUID, p_feature TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_plan    TEXT;
  v_status  TEXT;
  v_grace   TIMESTAMPTZ;
  v_custom  JSONB;    -- per-subscription custom overrides (Enterprise)
  v_flags   JSONB;    -- plan-level feature flags
  v_flag    JSONB;    -- resolved flag value for the requested feature
BEGIN
  SELECT s.plan, s.status, s.grace_period_end, s.features
  INTO   v_plan, v_status, v_grace, v_custom
  FROM   subscriptions s
  WHERE  s.fleet_id = p_fleet_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false, 'level', 'none',
      'reason',  'No subscription found.'
    );
  END IF;

  -- Expired / suspended beyond grace → deny all features
  IF v_status IN ('expired', 'suspended')
     AND (v_grace IS NULL OR v_grace < now()) THEN
    RETURN jsonb_build_object(
      'allowed', false, 'level', 'none',
      'reason',  'Subscription inactive. Please renew or contact support.'
    );
  END IF;

  -- 1. Enterprise custom overrides (subscriptions.features) take priority
  IF v_custom IS NOT NULL AND (v_custom ? p_feature) THEN
    v_flag := v_custom -> p_feature;
  ELSE
    -- 2. Fall back to plan-level feature_flags
    SELECT feature_flags INTO v_flags
    FROM   plan_definitions
    WHERE  plan_name = v_plan;

    v_flag := v_flags -> p_feature;
  END IF;

  -- Resolve flag → allowed / level
  IF v_flag IS NULL
     OR v_flag = to_jsonb(false)
     OR v_flag = '"false"'::jsonb THEN
    RETURN jsonb_build_object(
      'allowed', false, 'level', 'none', 'plan', v_plan
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'level',   CASE WHEN v_flag = '"limited"'::jsonb THEN 'limited' ELSE 'full' END,
    'plan',    v_plan
  );
END;
$$;

GRANT EXECUTE ON FUNCTION check_feature_access(UUID, TEXT) TO authenticated;


-- ── 7. admin_override_subscription — platform admin manual control ────────────
--
-- Only callable by users with { is_platform_admin: true } in their JWT metadata.
-- Set this in Supabase Dashboard → Authentication → Users → Edit user metadata.

CREATE OR REPLACE FUNCTION admin_override_subscription(
  p_fleet_id       UUID,
  p_plan           TEXT        DEFAULT NULL,
  p_status         TEXT        DEFAULT NULL,
  p_trial_ends_at  TIMESTAMPTZ DEFAULT NULL,
  p_max_vehicles   INTEGER     DEFAULT NULL,
  p_max_drivers    INTEGER     DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_is_admin BOOLEAN;
  v_old_plan TEXT;
  v_old_status TEXT;
BEGIN
  -- Verify the caller is a platform admin
  SELECT COALESCE(
    (auth.jwt() -> 'user_metadata' ->> 'is_platform_admin')::boolean,
    false
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'Unauthorized: platform admin access required'
      USING ERRCODE = '42501';
  END IF;

  -- Capture old values for audit trail
  SELECT plan, status INTO v_old_plan, v_old_status
  FROM subscriptions WHERE fleet_id = p_fleet_id;

  -- Apply overrides (NULL parameters are ignored — only update what is provided)
  UPDATE subscriptions
  SET
    plan           = COALESCE(p_plan,          plan),
    status         = COALESCE(p_status,        status),
    trial_ends_at  = COALESCE(p_trial_ends_at, trial_ends_at),
    max_vehicles   = COALESCE(p_max_vehicles,  max_vehicles),
    max_drivers    = COALESCE(p_max_drivers,   max_drivers),
    updated_at     = now()
  WHERE fleet_id = p_fleet_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Fleet subscription not found.');
  END IF;

  -- Audit log
  INSERT INTO audit_logs (user_id, fleet_id, action, resource_type, old_values, new_values)
  VALUES (
    auth.uid(),
    p_fleet_id,
    'admin_subscription_override',
    'subscription',
    jsonb_build_object('plan', v_old_plan, 'status', v_old_status),
    jsonb_build_object(
      'plan',          p_plan,
      'status',        p_status,
      'trial_ends_at', p_trial_ends_at,
      'max_vehicles',  p_max_vehicles,
      'max_drivers',   p_max_drivers
    )
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

-- Only authenticated users can call this, but the function itself
-- verifies is_platform_admin before doing anything
GRANT EXECUTE ON FUNCTION admin_override_subscription(UUID, TEXT, TEXT, TIMESTAMPTZ, INTEGER, INTEGER)
  TO authenticated;


-- ── 8. Trial auto-expiry via pg_cron (safe — skipped if extension not enabled) ─
--
-- Enable pg_cron in Supabase Dashboard → Database → Extensions before running.
-- If not enabled, this block silently skips — the rest of the migration succeeds.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Runs every hour: marks expired trials and starts 7-day grace period
    PERFORM cron.schedule(
      'ftpgo-expire-trials',
      '0 * * * *',
      $sql$
        UPDATE subscriptions
        SET
          status           = 'expired',
          grace_period_end = now() + INTERVAL '7 days',
          updated_at       = now()
        WHERE plan   = 'trial'
          AND status = 'trial'
          AND trial_ends_at < now()
          AND grace_period_end IS NULL;
      $sql$
    );

    -- Runs every hour: hard-lock fully expired grace periods
    PERFORM cron.schedule(
      'ftpgo-lock-grace-expired',
      '15 * * * *',
      $sql$
        UPDATE subscriptions
        SET updated_at = now()
        WHERE status = 'expired'
          AND grace_period_end IS NOT NULL
          AND grace_period_end < now();
      $sql$
    );
  ELSE
    RAISE NOTICE
      'pg_cron is not enabled. Trial auto-expiry will not run automatically. '
      'Enable pg_cron in Supabase Dashboard → Database → Extensions.';
  END IF;
END $$;


-- ── 9. Realtime notification trigger on subscription changes ─────────────────
--
-- Fires pg_notify on every UPDATE so frontend clients can re-fetch
-- subscription state instantly (used by useSubscription hook in Phase 3).

CREATE OR REPLACE FUNCTION fn_notify_subscription_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'subscription_changed',
    json_build_object(
      'fleet_id', NEW.fleet_id,
      'plan',     NEW.plan,
      'status',   NEW.status
    )::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_subscription_notify ON subscriptions;
CREATE TRIGGER trg_subscription_notify
  AFTER UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION fn_notify_subscription_change();


-- ── 10. Update fleet_vehicle_count view to use new plan names ────────────────

CREATE OR REPLACE VIEW fleet_vehicle_count AS
SELECT
  f.id                                                    AS fleet_id,
  f.name                                                  AS fleet_name,
  f.manager_id,
  COUNT(v.id)                                             AS vehicle_count,
  COALESCE(s.max_vehicles, pd.vehicle_limit, 2)           AS vehicle_limit,
  s.plan,
  s.status                                                AS subscription_status,
  s.trial_ends_at,
  s.grace_period_end,
  pd.price_inr,
  pd.display_name                                         AS plan_display_name,
  CASE
    WHEN COALESCE(s.max_vehicles, pd.vehicle_limit, 2) < 0 THEN false
    WHEN COUNT(v.id) >= COALESCE(s.max_vehicles, pd.vehicle_limit, 2) THEN true
    ELSE false
  END                                                     AS at_vehicle_limit
FROM fleets f
LEFT JOIN vehicles      v  ON v.fleet_id  = f.id
LEFT JOIN subscriptions s  ON s.fleet_id  = f.id
LEFT JOIN plan_definitions pd ON pd.plan_name = s.plan
GROUP BY
  f.id, f.name, f.manager_id,
  s.max_vehicles, s.plan, s.status, s.trial_ends_at,
  s.grace_period_end, pd.vehicle_limit, pd.price_inr, pd.display_name;


-- ── 11. Performance indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_status
  ON subscriptions(plan, status);

CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_ends
  ON subscriptions(trial_ends_at)
  WHERE status = 'trial';

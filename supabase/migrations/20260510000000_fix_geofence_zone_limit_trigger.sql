-- ═══════════════════════════════════════════════════════════════════════════
-- Fix zone-limit trigger to cover all subscription plan tiers.
--
-- Original trigger only handled 'free', 'starter', 'pro'.
-- 'growth' and 'enterprise' fell through to the ELSE (2 zones) — wrong.
--
-- Corrected limits:
--   trial      →  2  (same as free)
--   starter    →  10
--   growth     →  25
--   pro        →  unlimited
--   enterprise →  unlimited
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_check_geofence_zone_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count  INTEGER;
  v_plan   TEXT;
  v_limit  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM   geofences
  WHERE  fleet_id  = NEW.fleet_id
  AND    is_active = true;

  SELECT plan INTO v_plan
  FROM   subscriptions
  WHERE  fleet_id = NEW.fleet_id
  ORDER  BY created_at DESC
  LIMIT  1;

  v_limit := CASE COALESCE(v_plan, 'free')
    WHEN 'enterprise' THEN 999999
    WHEN 'pro'        THEN 999999
    WHEN 'growth'     THEN 25
    WHEN 'starter'    THEN 10
    ELSE 2   -- free / trial / unknown
  END;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'Zone limit reached for your current plan (% of % used). '
      'Upgrade to add more zones.',
      v_count, v_limit;
  END IF;

  RETURN NEW;
END;
$$;

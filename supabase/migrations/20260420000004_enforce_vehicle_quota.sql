-- ============================================================
-- Enforce vehicle quota at DB level via BEFORE INSERT trigger.
-- This is belt-and-suspenders alongside the vehicle-api edge function check.
-- (Fixes H1)
-- check_vehicle_quota() was created in 20260315000000_subscriptions.sql.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_vehicle_quota()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_quota RECORD;
BEGIN
  -- Only enforce when the vehicle is being assigned to a fleet.
  IF NEW.fleet_id IS NOT NULL THEN
    SELECT * INTO v_quota FROM check_vehicle_quota(NEW.fleet_id);
    IF FOUND AND NOT v_quota.allowed THEN
      RAISE EXCEPTION
        'Vehicle limit reached for your subscription plan (limit: %). Upgrade to add more vehicles.',
        v_quota.limit
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Drop and recreate so re-running the migration is safe.
DROP TRIGGER IF EXISTS trg_enforce_vehicle_quota ON vehicles;
CREATE TRIGGER trg_enforce_vehicle_quota
  BEFORE INSERT ON vehicles
  FOR EACH ROW
  EXECUTE FUNCTION enforce_vehicle_quota();

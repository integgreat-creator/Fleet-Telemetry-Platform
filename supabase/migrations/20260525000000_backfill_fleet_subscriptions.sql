-- ═══════════════════════════════════════════════════════════════════════════
-- BACKFILL: Ensure every fleet has a subscription row.
--
-- Problem: check_driver_limit() and check_vehicle_limit() return
--   { allowed: false, reason: 'No subscription found for this fleet' }
-- when no row exists in subscriptions. This blocks the Create Driver and
-- Add Vehicle modals entirely.
--
-- Root cause: the fn_create_fleet_subscription trigger fires AFTER INSERT on
-- fleets. If the new Supabase project was set up but some migrations were not
-- applied in the correct order, the trigger may be missing or may have failed
-- silently for existing fleets.
--
-- Fix: idempotent INSERT for any fleet that currently has no subscription.
--      Gives a 30-day trial so newly-onboarded managers have time to upgrade.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO subscriptions (
  fleet_id,
  plan,
  status,
  max_vehicles,
  max_drivers,
  trial_ends_at,
  updated_at
)
SELECT
  f.id,
  'trial',
  'trial',
  2,
  3,
  now() + INTERVAL '30 days',
  now()
FROM fleets f
WHERE NOT EXISTS (
  SELECT 1 FROM subscriptions s WHERE s.fleet_id = f.id
);

-- Log how many were created (useful for debugging in migration output)
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM subscriptions s
  JOIN fleets f ON f.id = s.fleet_id
  WHERE s.trial_ends_at > (now() - INTERVAL '1 minute');

  RAISE NOTICE 'backfill_fleet_subscriptions: % subscription row(s) confirmed', v_count;
END $$;

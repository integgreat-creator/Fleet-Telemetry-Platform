-- ═══════════════════════════════════════════════════════════════════════════
-- GRACE PERIOD AUTO-SET (Option B — BEFORE UPDATE trigger)
--
-- Problem: when a trial subscription expires (via pg_cron, admin override,
-- or any direct UPDATE), grace_period_end stays NULL. Both the web hook and
-- mobile SubscriptionProvider check isInGrace = isExpired && gracePeriodEnd
-- != null && gracePeriodEnd > now(). With NULL, isInGrace is always false
-- and the fleet is immediately hard-locked instead of getting 7 days of grace.
--
-- Solution: a BEFORE UPDATE trigger on subscriptions fires whenever status
-- transitions from 'trial' → 'expired' and grace_period_end is still NULL.
-- It sets grace_period_end = now() + 7 days in-place, before the row is
-- written. This covers:
--   • pg_cron automatic expiry
--   • admin_override_subscription() RPC
--   • any direct UPDATE from the Supabase dashboard or API
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_set_grace_period_on_expiry()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Only act when status is transitioning to 'expired'
  -- AND grace_period_end has not already been set manually
  IF NEW.status = 'expired'
     AND (OLD.status IS DISTINCT FROM 'expired')
     AND NEW.grace_period_end IS NULL
  THEN
    NEW.grace_period_end := now() + INTERVAL '7 days';
  END IF;

  RETURN NEW;
END;
$$;


-- ── 2. Attach trigger to subscriptions ───────────────────────────────────────

-- Drop first so re-running the migration is idempotent
DROP TRIGGER IF EXISTS trg_set_grace_period_on_expiry ON subscriptions;

CREATE TRIGGER trg_set_grace_period_on_expiry
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_grace_period_on_expiry();


-- ── 3. Back-fill: fix any rows already in 'expired' with no grace window ──────
--
-- Subscriptions that expired before this migration was applied have
-- grace_period_end = NULL and are incorrectly hard-locked. We set their
-- grace window to now() + 7 days so they get the full grace period from
-- the moment this migration runs.

UPDATE subscriptions
SET    grace_period_end = now() + INTERVAL '7 days'
WHERE  status           = 'expired'
AND    grace_period_end IS NULL;

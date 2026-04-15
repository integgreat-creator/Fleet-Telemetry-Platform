-- ═══════════════════════════════════════════════════════════════════════════
-- DRIVER LIMIT ENFORCEMENT
-- 1. check_driver_limit() RPC — mirrors check_vehicle_limit() for drivers
-- 2. Allow 'revoked' status on invitations (previously only pending/accepted/expired)
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. check_driver_limit ────────────────────────────────────────────────────
--
-- Returns JSONB:
--   { allowed: bool, reason?: text, limit: int, used: int, plan: text }

CREATE OR REPLACE FUNCTION check_driver_limit(p_fleet_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_plan        TEXT;
  v_status      TEXT;
  v_grace       TIMESTAMPTZ;
  v_max_drivers INTEGER;
  v_plan_limit  INTEGER;
  v_used        INTEGER;
  v_effective   INTEGER;
BEGIN
  -- Pull subscription row
  SELECT s.plan, s.status, s.grace_period_end, s.max_drivers
  INTO   v_plan, v_status, v_grace, v_max_drivers
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
      'reason',  'Your subscription has expired. Please renew to add drivers.'
    );
  END IF;

  -- Get the plan's default driver limit
  SELECT driver_limit
  INTO   v_plan_limit
  FROM   plan_definitions
  WHERE  plan_name = v_plan;

  -- Effective limit: subscription-level override takes precedence over plan default
  -- -1 means unlimited (Enterprise custom)
  v_effective := COALESCE(v_max_drivers, v_plan_limit, 3);

  IF v_effective < 0 THEN
    RETURN jsonb_build_object(
      'allowed', true,
      'limit',   -1,
      'used',    0,
      'plan',    v_plan
    );
  END IF;

  -- Count current driver accounts for this fleet
  SELECT COUNT(*) INTO v_used
  FROM   driver_accounts
  WHERE  fleet_id = p_fleet_id;

  IF v_used >= v_effective THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason',  format(
        'Driver limit reached (%s/%s). Upgrade your plan to add more drivers.',
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

GRANT EXECUTE ON FUNCTION check_driver_limit(UUID) TO authenticated;


-- ── 2. Allow 'revoked' status on invitations ─────────────────────────────────
--
-- The existing CHECK constraint only allows ('pending','accepted','expired').
-- Extend it to also allow 'revoked' for the new revoke action in invite-api.

ALTER TABLE invitations
  DROP CONSTRAINT IF EXISTS invitations_status_check;

ALTER TABLE invitations
  ADD CONSTRAINT invitations_status_check
  CHECK (status IN ('pending', 'accepted', 'expired', 'revoked'));

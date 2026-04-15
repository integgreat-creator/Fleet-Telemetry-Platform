-- ═══════════════════════════════════════════════════════════════════════════
-- GEOFENCING SCHEMA
--
-- Three tables:
--   geofences            – zone boundary definitions (circle or polygon)
--   geofence_assignments – which vehicles monitor which zones + alert config
--   geofence_vehicle_state – current inside/outside state per vehicle/zone
--                            (authoritative server-side memory; written only
--                             by the geofence-monitor edge function)
--
-- Zone count limit enforced by a BEFORE INSERT trigger keyed to the fleet
-- subscription plan: Free=2, Starter=10, Pro=unlimited.
--
-- RLS: fleet manager can read/write their own fleet's geofences.
--      Drivers can read assignments for their vehicle only.
--      geofence_vehicle_state is read-only for authenticated users
--      (all writes go through the service-role edge function).
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. geofences ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS geofences (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id                UUID        NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  name                    TEXT        NOT NULL,
  zone_type               TEXT        NOT NULL DEFAULT 'custom',
    -- 'depot' | 'customer' | 'restricted' | 'city' | 'state' | 'custom'
  shape                   TEXT        NOT NULL DEFAULT 'circle',
    -- 'circle' | 'polygon'
  -- Circle fields (shape = 'circle')
  center_lat              NUMERIC(10, 7),
  center_lng              NUMERIC(10, 7),
  radius_metres           NUMERIC(10, 2),
  -- Polygon fields (shape = 'polygon')
  -- [[lat, lng], ...] — max 50 vertices enforced in application layer
  coordinates             JSONB,
  -- Optional time restriction for night-movement detection
  time_restriction_start  TIME,
  time_restriction_end    TIME,
  -- Display
  color                   TEXT        NOT NULL DEFAULT '#3B82F6',
  is_active               BOOLEAN     NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS geofences_fleet_idx      ON geofences(fleet_id);
CREATE INDEX IF NOT EXISTS geofences_active_idx     ON geofences(fleet_id) WHERE is_active = true;

ALTER TABLE geofences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "geofences_fleet_access" ON geofences;
CREATE POLICY "geofences_fleet_access" ON geofences
  FOR ALL TO authenticated
  USING  (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));


-- ── 2. geofence_assignments ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS geofence_assignments (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  geofence_id      UUID    NOT NULL REFERENCES geofences(id)  ON DELETE CASCADE,
  vehicle_id       UUID    NOT NULL REFERENCES vehicles(id)   ON DELETE CASCADE,
  alert_on_entry   BOOLEAN NOT NULL DEFAULT true,
  alert_on_exit    BOOLEAN NOT NULL DEFAULT true,
  alert_on_dwell   BOOLEAN NOT NULL DEFAULT false,
  dwell_minutes    INTEGER NOT NULL DEFAULT 30,
  -- {"in_app": true, "whatsapp": false}
  alert_channels   JSONB   NOT NULL DEFAULT '{"in_app": true, "whatsapp": false}',
  cooldown_minutes INTEGER NOT NULL DEFAULT 15,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (geofence_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS geofence_assignments_vehicle_idx  ON geofence_assignments(vehicle_id);
CREATE INDEX IF NOT EXISTS geofence_assignments_geofence_idx ON geofence_assignments(geofence_id);

ALTER TABLE geofence_assignments ENABLE ROW LEVEL SECURITY;

-- Fleet managers can fully manage assignments for their zones
DROP POLICY IF EXISTS "geofence_assignments_manager" ON geofence_assignments;
CREATE POLICY "geofence_assignments_manager" ON geofence_assignments
  FOR ALL TO authenticated
  USING (
    geofence_id IN (
      SELECT id FROM geofences
      WHERE fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    geofence_id IN (
      SELECT id FROM geofences
      WHERE fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

-- Drivers can read assignments for their own vehicle
DROP POLICY IF EXISTS "geofence_assignments_driver_read" ON geofence_assignments;
CREATE POLICY "geofence_assignments_driver_read" ON geofence_assignments
  FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid()
    )
  );


-- ── 3. geofence_vehicle_state ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS geofence_vehicle_state (
  geofence_id      UUID        NOT NULL REFERENCES geofences(id)  ON DELETE CASCADE,
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id)   ON DELETE CASCADE,
  is_inside        BOOLEAN     NOT NULL DEFAULT false,
  entered_at       TIMESTAMPTZ,          -- when vehicle last entered this zone
  last_checked_at  TIMESTAMPTZ,
  last_event_at    TIMESTAMPTZ,          -- used for cooldown calculation
  PRIMARY KEY (geofence_id, vehicle_id)
);

CREATE INDEX IF NOT EXISTS geofence_state_vehicle_idx ON geofence_vehicle_state(vehicle_id);

ALTER TABLE geofence_vehicle_state ENABLE ROW LEVEL SECURITY;

-- Fleet managers can read state (read-only via this policy; writes use service role)
DROP POLICY IF EXISTS "geofence_state_manager_read" ON geofence_vehicle_state;
CREATE POLICY "geofence_state_manager_read" ON geofence_vehicle_state
  FOR SELECT TO authenticated
  USING (
    geofence_id IN (
      SELECT id FROM geofences
      WHERE fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );


-- ── 4. Zone count limit ───────────────────────────────────────────────────────
-- Enforced at INSERT time via a BEFORE trigger so it cannot be bypassed via
-- direct SQL or API calls, regardless of what the UI shows.

CREATE OR REPLACE FUNCTION fn_check_geofence_zone_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count     INTEGER;
  v_plan      TEXT;
  v_limit     INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM   geofences
  WHERE  fleet_id  = NEW.fleet_id
  AND    is_active = true;

  -- Derive plan from the subscriptions table (same pattern as feature-access migration)
  SELECT plan INTO v_plan
  FROM   subscriptions
  WHERE  fleet_id = NEW.fleet_id
  ORDER  BY created_at DESC
  LIMIT  1;

  v_limit := CASE COALESCE(v_plan, 'free')
    WHEN 'pro'     THEN 999999
    WHEN 'starter' THEN 10
    ELSE                2        -- free / unknown
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

DROP TRIGGER IF EXISTS trg_geofence_zone_limit ON geofences;
CREATE TRIGGER trg_geofence_zone_limit
  BEFORE INSERT ON geofences
  FOR EACH ROW
  EXECUTE FUNCTION fn_check_geofence_zone_limit();

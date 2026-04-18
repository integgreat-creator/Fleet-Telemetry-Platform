-- ============================================================
-- Fix schema gaps identified in audit:
--   C2: recorded_at → timestamp in geofence/anomaly functions
--   C3: Add battery_capacity_kwh, cng_capacity_kg to vehicles
--   C4/H2: Add status, start_time, end_time to trips (dual-schema fix)
-- ============================================================

-- ── 1. Add missing vehicle fuel columns (C3) ────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS battery_capacity_kwh numeric,
  ADD COLUMN IF NOT EXISTS cng_capacity_kg       numeric;

-- ── 2. Add missing trips columns (C4 / H2) ──────────────────────────────────
-- trips currently has: started_at, ended_at (migration 20260327000001)
-- fleet-intelligence inserts: start_time, end_time, status
-- Add all three so both paths work without changing any existing behaviour.
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS status     text        NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS start_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time   timestamptz;

-- Back-fill only if the old started_at/ended_at columns exist.
-- DBs that already use start_time/end_time natively skip this block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'trips'
      AND column_name  = 'started_at'
  ) THEN
    UPDATE trips
    SET start_time = started_at,
        end_time   = ended_at,
        status     = CASE WHEN ended_at IS NULL THEN 'active' ELSE 'completed' END
    WHERE start_time IS NULL;
  END IF;
END $$;

-- Index on status for the active-trip lookup in fleet-intelligence.
CREATE INDEX IF NOT EXISTS trips_vehicle_status_idx
  ON trips (vehicle_id, status);

-- ── 3. Fix geofence violation trigger: recorded_at → timestamp (C2) ─────────
-- The function created in 20260329000001_geofences_and_stops.sql used
-- recorded_at but vehicle_locations stores the column as `timestamp`.
-- We recreate the function with the correct column name.

CREATE OR REPLACE FUNCTION detect_geofence_violations()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_geofence   RECORD;
  v_distance_m double precision;
  v_was_inside boolean;
  v_is_inside  boolean;
BEGIN
  FOR v_geofence IN
    SELECT g.*
    FROM   geofences g
    JOIN   geofence_assignments ga ON ga.geofence_id = g.id
    WHERE  ga.vehicle_id = NEW.vehicle_id
      AND  g.is_active   = true
  LOOP
    -- Distance from new location to geofence centre (metres).
    v_distance_m := (
      6371000 * acos(
        LEAST(1.0,
          cos(radians(v_geofence.center_lat)) * cos(radians(NEW.lat)) *
          cos(radians(NEW.lng) - radians(v_geofence.center_lng)) +
          sin(radians(v_geofence.center_lat)) * sin(radians(NEW.lat))
        )
      )
    );
    v_is_inside := v_distance_m <= v_geofence.radius_meters;

    -- Was the vehicle inside on its previous fix?
    SELECT EXISTS (
      SELECT 1
      FROM   vehicle_locations vl
      WHERE  vl.vehicle_id = NEW.vehicle_id
        AND  vl.timestamp  < NEW.timestamp           -- FIXED: was recorded_at
        AND  (
          6371000 * acos(
            LEAST(1.0,
              cos(radians(v_geofence.center_lat)) * cos(radians(vl.lat)) *
              cos(radians(vl.lng)  - radians(v_geofence.center_lng)) +
              sin(radians(v_geofence.center_lat)) * sin(radians(vl.lat))
            )
          )
        ) <= v_geofence.radius_meters
      ORDER BY vl.timestamp DESC                     -- FIXED: was recorded_at
      LIMIT 1
    ) INTO v_was_inside;

    -- Record a violation only on a boundary crossing.
    IF v_is_inside <> v_was_inside THEN
      INSERT INTO geofence_violations (
        vehicle_id, geofence_id, event_type, lat, lng, occurred_at
      ) VALUES (
        NEW.vehicle_id,
        v_geofence.id,
        CASE WHEN v_is_inside THEN 'entry' ELSE 'exit' END,
        NEW.lat,
        NEW.lng,
        NEW.timestamp                                -- FIXED: was recorded_at
      );
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- ── 4. Fix movement-anomaly function: recorded_at → timestamp (C2) ──────────
CREATE OR REPLACE FUNCTION detect_movement_anomalies()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_recent_count integer;
  v_time_window  interval := INTERVAL '10 minutes';
BEGIN
  SELECT COUNT(*) INTO v_recent_count
  FROM   vehicle_locations vl
  WHERE  vl.vehicle_id = NEW.vehicle_id
    AND  vl.timestamp  > now() - v_time_window;     -- FIXED: was recorded_at

  IF v_recent_count = 0 THEN
    INSERT INTO device_events (vehicle_id, event_type, metadata, occurred_at)
    VALUES (
      NEW.vehicle_id,
      'movement_anomaly',
      jsonb_build_object('reason', 'no_recent_locations', 'window_minutes', 10),
      now()
    );
  END IF;
  RETURN NEW;
END;
$$;

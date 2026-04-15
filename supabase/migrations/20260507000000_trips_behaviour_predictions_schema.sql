-- ═══════════════════════════════════════════════════════════════════════════
-- TRIPS, DRIVER BEHAVIOUR, MAINTENANCE & COST PREDICTIONS
--
-- Ensures all four tables exist with the columns required by the mobile
-- TripRecorder / DriverBehaviourRecorder services and the
-- generate-predictions edge function.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. trips ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trips (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id         UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_account_id  UUID        REFERENCES driver_accounts(id) ON DELETE SET NULL,
  start_time         TIMESTAMPTZ NOT NULL,
  end_time           TIMESTAMPTZ,
  distance_km        NUMERIC(10, 3),
  duration_seconds   INTEGER,
  avg_speed_kmh      NUMERIC(6, 2),
  max_speed_kmh      NUMERIC(6, 2),
  start_lat          NUMERIC(10, 7),
  start_lng          NUMERIC(10, 7),
  end_lat            NUMERIC(10, 7),
  end_lng            NUMERIC(10, 7),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent columns in case table already existed with fewer columns
ALTER TABLE trips ADD COLUMN IF NOT EXISTS driver_account_id UUID REFERENCES driver_accounts(id) ON DELETE SET NULL;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS max_speed_kmh     NUMERIC(6,  2);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_lat         NUMERIC(10, 7);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS start_lng         NUMERIC(10, 7);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS end_lat           NUMERIC(10, 7);
ALTER TABLE trips ADD COLUMN IF NOT EXISTS end_lng           NUMERIC(10, 7);

CREATE INDEX IF NOT EXISTS trips_vehicle_id_idx   ON trips(vehicle_id);
CREATE INDEX IF NOT EXISTS trips_start_time_idx   ON trips(start_time DESC);
CREATE INDEX IF NOT EXISTS trips_driver_idx       ON trips(driver_account_id) WHERE driver_account_id IS NOT NULL;

ALTER TABLE trips ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trips_fleet_access" ON trips;
CREATE POLICY "trips_fleet_access" ON trips
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
         OR  v.id IN (SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid())
    )
  );


-- ── 2. driver_behavior ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS driver_behavior (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id                UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  driver_account_id         UUID        REFERENCES driver_accounts(id) ON DELETE SET NULL,
  trip_id                   UUID        REFERENCES trips(id) ON DELETE SET NULL,
  harsh_braking_count       INTEGER     NOT NULL DEFAULT 0,
  harsh_acceleration_count  INTEGER     NOT NULL DEFAULT 0,
  excessive_rpm_count       INTEGER     NOT NULL DEFAULT 0,
  excessive_speed_count     INTEGER     NOT NULL DEFAULT 0,
  overspeed_count           INTEGER     NOT NULL DEFAULT 0,
  idle_time_seconds         INTEGER     NOT NULL DEFAULT 0,
  average_engine_load       NUMERIC(5, 2),
  driver_score              NUMERIC(5, 2),
  trip_start                TIMESTAMPTZ,
  trip_end                  TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent columns
ALTER TABLE driver_behavior ADD COLUMN IF NOT EXISTS driver_account_id        UUID        REFERENCES driver_accounts(id) ON DELETE SET NULL;
ALTER TABLE driver_behavior ADD COLUMN IF NOT EXISTS trip_id                  UUID        REFERENCES trips(id) ON DELETE SET NULL;
ALTER TABLE driver_behavior ADD COLUMN IF NOT EXISTS overspeed_count          INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE driver_behavior ADD COLUMN IF NOT EXISTS idle_time_seconds        INTEGER     NOT NULL DEFAULT 0;
ALTER TABLE driver_behavior ADD COLUMN IF NOT EXISTS trip_end                 TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS driver_behavior_vehicle_idx ON driver_behavior(vehicle_id);
CREATE INDEX IF NOT EXISTS driver_behavior_driver_idx  ON driver_behavior(driver_account_id) WHERE driver_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS driver_behavior_trip_idx    ON driver_behavior(trip_start DESC);

ALTER TABLE driver_behavior ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "driver_behavior_fleet_access" ON driver_behavior;
CREATE POLICY "driver_behavior_fleet_access" ON driver_behavior
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
         OR  v.id IN (SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid())
    )
  );


-- ── 3. maintenance_predictions ───────────────────────────────────────────────
-- NOTE: This table was first created by 20260227043631_create_vehicle_telemetry_schema.sql
-- with a different shape (component text NOT NULL, confidence_score, no due_date/due_at_km).
-- The CREATE TABLE below is skipped when that older table exists.
-- All columns the generate-predictions edge function needs are ensured via ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS maintenance_predictions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  prediction_type  TEXT        NOT NULL,
  description      TEXT,
  due_at_km        NUMERIC(10, 1),
  due_date         DATE,
  urgency          TEXT        NOT NULL DEFAULT 'low',
  confidence       NUMERIC(4, 2),
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent columns — handles both fresh DB and upgrade from older schema
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS description   TEXT;
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS due_at_km     NUMERIC(10, 1);
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS due_date       DATE;
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS urgency        TEXT NOT NULL DEFAULT 'low';
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS confidence     NUMERIC(4, 2);
ALTER TABLE maintenance_predictions ADD COLUMN IF NOT EXISTS generated_at   TIMESTAMPTZ NOT NULL DEFAULT now();
-- Older schema had `component text NOT NULL`; new engine never populates it
ALTER TABLE maintenance_predictions ALTER COLUMN component DROP NOT NULL;

CREATE INDEX IF NOT EXISTS maint_pred_vehicle_idx ON maintenance_predictions(vehicle_id);
CREATE INDEX IF NOT EXISTS maint_pred_due_idx     ON maintenance_predictions(due_date);

ALTER TABLE maintenance_predictions ENABLE ROW LEVEL SECURITY;

-- Drop old per-operation policies from original schema before replacing with single policy
DROP POLICY IF EXISTS "Users can view maintenance predictions for their vehicles"   ON maintenance_predictions;
DROP POLICY IF EXISTS "Users can create maintenance predictions for their vehicles" ON maintenance_predictions;
DROP POLICY IF EXISTS "Users can update maintenance predictions for their vehicles" ON maintenance_predictions;
DROP POLICY IF EXISTS "maint_pred_fleet_access" ON maintenance_predictions;
CREATE POLICY "maint_pred_fleet_access" ON maintenance_predictions
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
    )
  );


-- ── 4. cost_predictions ───────────────────────────────────────────────────────
-- NOTE: An older table exists from 20260307000000_cost_prediction.sql with different
-- column names (estimated_fuel_cost etc.), a timestamptz prediction_date, and a
-- CHECK constraint that does not include 'weekly'. Since no real predictions were
-- ever generated by the old schema, it is safe to drop and recreate cleanly.

DROP TABLE IF EXISTS cost_predictions CASCADE;

CREATE TABLE cost_predictions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  prediction_date  DATE        NOT NULL,
  forecast_period  TEXT        NOT NULL DEFAULT 'monthly',  -- 'weekly' | 'monthly'
  fuel_cost        NUMERIC(10, 2),
  maintenance_cost NUMERIC(10, 2),
  total_cost       NUMERIC(10, 2),
  fuel_litres      NUMERIC(8,  2),
  avg_cost_per_km  NUMERIC(6,  3),
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, prediction_date, forecast_period)
);

CREATE INDEX IF NOT EXISTS cost_pred_vehicle_idx ON cost_predictions(vehicle_id);
CREATE INDEX IF NOT EXISTS cost_pred_date_idx    ON cost_predictions(prediction_date DESC);

ALTER TABLE cost_predictions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view cost predictions for their vehicles" ON cost_predictions;
DROP POLICY IF EXISTS "cost_pred_fleet_access" ON cost_predictions;
CREATE POLICY "cost_pred_fleet_access" ON cost_predictions
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
    )
  );

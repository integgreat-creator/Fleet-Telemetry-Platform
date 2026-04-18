-- ============================================================
-- Fleet Intelligence: ensure the 5 tables exist with the
-- columns the fleet-intelligence edge function requires.
--
-- Tables already exist in this DB with a different earlier schema.
-- This migration is additive only — no data is dropped.
--   • CREATE TABLE IF NOT EXISTS  → creates table if absent
--   • ALTER TABLE ADD COLUMN IF NOT EXISTS → adds columns if absent
--   • DROP / CREATE POLICY       → idempotent RLS setup
-- ============================================================

-- ── 0. vehicles.fleet_id (safety net) ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'vehicles'
      AND column_name  = 'fleet_id'
  ) THEN
    ALTER TABLE vehicles
      ADD COLUMN fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS vehicles_fleet_id_idx ON vehicles (fleet_id);

-- ── 1. historical_cost_data ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_cost_data (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date       timestamptz NOT NULL DEFAULT now(),
  amount     numeric     NOT NULL DEFAULT 0,
  category   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Edge function uses: vehicle_id, date (order), amount (sum) — all present.
CREATE INDEX IF NOT EXISTS historical_cost_data_vehicle_date_idx
  ON historical_cost_data (vehicle_id, date DESC);

-- ── 2. historical_traffic_data ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS historical_traffic_data (
  id               uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  latitude         numeric          NOT NULL,
  longitude        numeric          NOT NULL,
  congestion_level numeric          NOT NULL DEFAULT 0,
  timestamp        timestamptz      NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS historical_traffic_data_location_idx
  ON historical_traffic_data (latitude, longitude);

-- ── 3. destinations ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS destinations (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text    NOT NULL,
  latitude   numeric NOT NULL,
  longitude  numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- fleet_id is required by the edge function route optimiser and RLS policies.
-- Add it to the existing table if it is not already present.
ALTER TABLE destinations
  ADD COLUMN IF NOT EXISTS fleet_id uuid REFERENCES fleets(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS destinations_fleet_id_idx ON destinations (fleet_id);

-- ── 4. optimized_routes ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS optimized_routes (
  id                    uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id              uuid    REFERENCES fleets(id) ON DELETE CASCADE,
  origin_lat            numeric,
  origin_lng            numeric,
  destination_id        uuid    REFERENCES destinations(id) ON DELETE SET NULL,
  estimated_distance_km numeric,
  traffic_score         numeric,
  fuel_efficiency_score numeric,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS optimized_routes_fleet_id_idx
  ON optimized_routes (fleet_id, created_at DESC);

-- ── 5. cost_predictions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_predictions (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     uuid    NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  forecast_period text   NOT NULL DEFAULT 'monthly',
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- The edge function inserts these columns; add them if they are missing.
ALTER TABLE cost_predictions
  ADD COLUMN IF NOT EXISTS estimated_fuel_cost        numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_maintenance_cost numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_insurance_cost   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_total_cost       numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confidence_score           numeric NOT NULL DEFAULT 0.6,
  ADD COLUMN IF NOT EXISTS factors                    jsonb;
CREATE INDEX IF NOT EXISTS cost_predictions_vehicle_id_idx
  ON cost_predictions (vehicle_id, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE historical_cost_data    ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_traffic_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE destinations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE optimized_routes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_predictions        ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fleet_manager_cost_data_all"          ON historical_cost_data;
DROP POLICY IF EXISTS "authenticated_read_traffic"            ON historical_traffic_data;
DROP POLICY IF EXISTS "service_insert_traffic"                ON historical_traffic_data;
DROP POLICY IF EXISTS "fleet_manager_destinations_all"        ON destinations;
DROP POLICY IF EXISTS "fleet_manager_routes_all"              ON optimized_routes;
DROP POLICY IF EXISTS "fleet_manager_cost_predictions_all"    ON cost_predictions;

CREATE POLICY "fleet_manager_cost_data_all" ON historical_cost_data
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles
      WHERE owner_id = auth.uid()
         OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT id FROM vehicles
      WHERE owner_id = auth.uid()
         OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "authenticated_read_traffic" ON historical_traffic_data
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "service_insert_traffic" ON historical_traffic_data
  FOR INSERT WITH CHECK (true);

CREATE POLICY "fleet_manager_destinations_all" ON destinations
  FOR ALL TO authenticated
  USING  (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));

CREATE POLICY "fleet_manager_routes_all" ON optimized_routes
  FOR ALL TO authenticated
  USING  (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));

CREATE POLICY "fleet_manager_cost_predictions_all" ON cost_predictions
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles
      WHERE owner_id = auth.uid()
         OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT id FROM vehicles
      WHERE owner_id = auth.uid()
         OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

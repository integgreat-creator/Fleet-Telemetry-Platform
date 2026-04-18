-- ============================================================
-- Fix RLS gaps identified in audit:
--   M1: cost_insights had RLS enabled but zero policies
--   M2: drivers table missing INSERT / UPDATE / DELETE policies
--   M3: driver_behavior.trip_id missing FK constraint
-- ============================================================

-- ── 1. cost_insights: add missing write + read policies (M1) ────────────────
DROP POLICY IF EXISTS "fleet_manager_read_insights"   ON cost_insights;
DROP POLICY IF EXISTS "service_insert_insights"        ON cost_insights;
DROP POLICY IF EXISTS "fleet_manager_update_insights"  ON cost_insights;
DROP POLICY IF EXISTS "fleet_manager_delete_insights"  ON cost_insights;

-- SELECT policy for fleet managers
CREATE POLICY "fleet_manager_read_insights" ON cost_insights
  FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      JOIN   fleets f ON f.id = v.fleet_id
      WHERE  f.manager_id = auth.uid()
    )
  );

-- INSERT allowed to any authenticated user (edge function runs as user context)
CREATE POLICY "service_insert_insights" ON cost_insights
  FOR INSERT WITH CHECK (true);

-- UPDATE / DELETE scoped to fleet manager
CREATE POLICY "fleet_manager_update_insights" ON cost_insights
  FOR UPDATE TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      JOIN   fleets f ON f.id = v.fleet_id
      WHERE  f.manager_id = auth.uid()
    )
  );

CREATE POLICY "fleet_manager_delete_insights" ON cost_insights
  FOR DELETE TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      JOIN   fleets f ON f.id = v.fleet_id
      WHERE  f.manager_id = auth.uid()
    )
  );

-- ── 2. drivers table: add missing write policies (M2) ───────────────────────
DROP POLICY IF EXISTS "fleet_manager_insert_drivers" ON drivers;
DROP POLICY IF EXISTS "fleet_manager_update_drivers" ON drivers;
DROP POLICY IF EXISTS "fleet_manager_delete_drivers" ON drivers;

-- The existing SELECT policy "Users can view drivers in their fleet" stays.
-- Add the three missing write policies.

CREATE POLICY "fleet_manager_insert_drivers" ON drivers
  FOR INSERT TO authenticated
  WITH CHECK (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "fleet_manager_update_drivers" ON drivers
  FOR UPDATE TO authenticated
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  )
  WITH CHECK (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "fleet_manager_delete_drivers" ON drivers
  FOR DELETE TO authenticated
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

-- ── 3. driver_behavior.trip_id: add FK constraint (M3) ──────────────────────
-- Wrapped in DO block so it's idempotent on re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   information_schema.table_constraints
    WHERE  constraint_name = 'driver_behavior_trip_id_fkey'
      AND  table_name      = 'driver_behavior'
  ) THEN
    ALTER TABLE driver_behavior
      ADD CONSTRAINT driver_behavior_trip_id_fkey
      FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;
  END IF;
END $$;

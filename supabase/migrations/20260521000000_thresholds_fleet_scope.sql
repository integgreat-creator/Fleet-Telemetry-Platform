-- ============================================================
-- Thresholds: add fleet_id for fleet-level (non-vehicle) rows
--
-- Changes:
--   • Makes vehicle_id nullable (fleet-level rows have no vehicle_id)
--   • Adds fleet_id FK column
--   • Drops old unique(vehicle_id, sensor_type) constraint
--   • Adds two partial unique indexes:
--       - vehicle-level: (vehicle_id, sensor_type) WHERE vehicle_id IS NOT NULL
--       - fleet-level:   (fleet_id,   sensor_type) WHERE vehicle_id IS NULL
--   • Adds CHECK: at least one of vehicle_id / fleet_id must be set
--   • Updates RLS to allow fleet managers to manage fleet-level rows
-- ============================================================

-- 1. Make vehicle_id nullable
ALTER TABLE thresholds
  ALTER COLUMN vehicle_id DROP NOT NULL;

-- 2. Add fleet_id column
ALTER TABLE thresholds
  ADD COLUMN IF NOT EXISTS fleet_id UUID REFERENCES fleets(id) ON DELETE CASCADE;

-- 3. Add CHECK constraint: exactly one scope set
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'thresholds' AND constraint_name = 'chk_thresholds_scope'
  ) THEN
    ALTER TABLE thresholds
      ADD CONSTRAINT chk_thresholds_scope
        CHECK (
          (vehicle_id IS NOT NULL AND fleet_id IS NULL)
          OR
          (vehicle_id IS NULL AND fleet_id IS NOT NULL)
        );
  END IF;
END $$;

-- 4. Drop old unique constraint (named automatically by Postgres)
ALTER TABLE thresholds
  DROP CONSTRAINT IF EXISTS thresholds_vehicle_id_sensor_type_key;

-- 5. Add partial unique indexes
CREATE UNIQUE INDEX IF NOT EXISTS thresholds_vehicle_sensor_uidx
  ON thresholds (vehicle_id, sensor_type)
  WHERE vehicle_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS thresholds_fleet_sensor_uidx
  ON thresholds (fleet_id, sensor_type)
  WHERE vehicle_id IS NULL;

-- 6. Update RLS policies to cover fleet-level rows
-- (vehicle-level policy already covers manager via vehicle ownership;
--  add a separate policy for fleet-level rows)

DROP POLICY IF EXISTS "thresholds_fleet_level_access" ON thresholds;
CREATE POLICY "thresholds_fleet_level_access" ON thresholds
  FOR ALL TO authenticated
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    AND vehicle_id IS NULL
  )
  WITH CHECK (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    AND vehicle_id IS NULL
  );

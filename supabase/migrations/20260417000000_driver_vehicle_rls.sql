-- ─────────────────────────────────────────────────────────────────────────────
-- Drivers need to read their assigned vehicle.
--
-- Vehicles registered via create_vehicle_for_driver have owner_id = fleet
-- manager, NOT the driver's auth.uid().  The existing SELECT policy only
-- covers the owner and fleet managers, so drivers see zero vehicles — causing
-- the My Vehicles screen to spin indefinitely (empty result + no error).
--
-- This migration adds a supplementary SELECT policy that grants drivers access
-- to exactly the vehicle assigned to them in driver_accounts.
-- ─────────────────────────────────────────────────────────────────────────────

-- vehicles: let drivers read their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'vehicles'
      AND policyname = 'drivers_view_assigned_vehicle'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle"
      ON vehicles FOR SELECT TO authenticated
      USING (
        id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- sensor_data: drivers can read sensor data for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'sensor_data'
      AND policyname = 'drivers_view_assigned_vehicle_sensor_data'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle_sensor_data"
      ON sensor_data FOR SELECT TO authenticated
      USING (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- thresholds: drivers can read thresholds for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'thresholds'
      AND policyname = 'drivers_view_assigned_vehicle_thresholds'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle_thresholds"
      ON thresholds FOR SELECT TO authenticated
      USING (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- alerts: drivers can read alerts for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'alerts'
      AND policyname = 'drivers_view_assigned_vehicle_alerts'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle_alerts"
      ON alerts FOR SELECT TO authenticated
      USING (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- sensor_registry: drivers can read sensor registry for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'sensor_registry'
      AND policyname = 'drivers_view_assigned_vehicle_sensor_registry'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle_sensor_registry"
      ON sensor_registry FOR SELECT TO authenticated
      USING (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- device_health: drivers can read device health for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'device_health'
      AND policyname = 'drivers_view_assigned_vehicle_device_health'
  ) THEN
    CREATE POLICY "drivers_view_assigned_vehicle_device_health"
      ON device_health FOR SELECT TO authenticated
      USING (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

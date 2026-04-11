-- ─────────────────────────────────────────────────────────────────────────────
-- Drivers must be able to INSERT sensor data for their assigned vehicle.
--
-- Problem: sensor_data INSERT policy only permits rows where
--   vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
-- Vehicles created for a driver via create_vehicle_for_driver have
-- owner_id = fleet_manager, NOT the driver's auth.uid().
-- Result: every sensor reading sent from the mobile app is silently rejected
-- by RLS and never reaches the database.  The web dashboard therefore shows
-- "No sensor data available" even when the driver is actively connected.
--
-- Fix: supplementary INSERT policies that check driver_accounts.vehicle_id
-- instead of vehicles.owner_id.
-- ─────────────────────────────────────────────────────────────────────────────

-- sensor_data: allow drivers to insert readings for their assigned vehicle
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'sensor_data'
      AND policyname = 'drivers_insert_sensor_data_for_assigned_vehicle'
  ) THEN
    CREATE POLICY "drivers_insert_sensor_data_for_assigned_vehicle"
      ON sensor_data FOR INSERT TO authenticated
      WITH CHECK (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

-- alerts: allow drivers (and the sensor-api edge function running as the driver)
-- to insert alerts for their assigned vehicle so threshold / anomaly alerts
-- are properly recorded.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'alerts'
      AND policyname = 'drivers_insert_alerts_for_assigned_vehicle'
  ) THEN
    CREATE POLICY "drivers_insert_alerts_for_assigned_vehicle"
      ON alerts FOR INSERT TO authenticated
      WITH CHECK (
        vehicle_id IN (
          SELECT vehicle_id
          FROM   driver_accounts
          WHERE  user_id    = auth.uid()
            AND  vehicle_id IS NOT NULL
        )
      );
  END IF;
END $$;

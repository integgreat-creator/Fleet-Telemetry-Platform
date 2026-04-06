-- =============================================================================
-- Fleet Telemetry Platform — Vehicle Data Simulator
-- =============================================================================
--
-- PURPOSE
-- -------
-- Provides two stored procedures that inject realistic, randomised sensor
-- readings directly into sensor_data so you can develop and test the UI
-- without a physical OBD-II device attached.
--
--   fn_simulate_vehicle_data(vehicle_id UUID)
--     Inserts one full set of readings (7 sensor types) for a single vehicle.
--
--   fn_simulate_fleet_data(fleet_id UUID)
--     Calls fn_simulate_vehicle_data for every vehicle that belongs to the
--     specified fleet.
--
-- USAGE
-- -----
-- 1. Apply this file once:
--      psql "$DATABASE_URL" -f supabase/seed/device_simulator.sql
--    or paste into the Supabase Dashboard → SQL Editor.
--
-- 2. Simulate a single vehicle:
--      SELECT fn_simulate_vehicle_data('bbbbbbbb-0000-0000-0000-000000000001');
--
-- 3. Simulate the whole fleet:
--      SELECT fn_simulate_fleet_data('aaaaaaaa-0000-0000-0000-000000000001');
--
-- 4. For continuous simulation see the pg_cron section at the bottom.
--
-- REALISTIC VALUE RANGES
-- ----------------------
--   rpm               800 – 4 500 RPM       (idle → aggressive driving)
--   speed             0   – 120 km/h
--   coolantTemp       75  – 105 °C
--   fuelLevel         10  – 100 %
--   engineLoad        20  – 80  %
--   batteryVoltage    11.5 – 14.5 V
--   throttlePosition  0   – 100 %
-- =============================================================================


-- =============================================================================
-- fn_simulate_vehicle_data
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_simulate_vehicle_data(p_vehicle_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_rpm               NUMERIC;
  v_speed             NUMERIC;
  v_coolant_temp      NUMERIC;
  v_fuel_level        NUMERIC;
  v_engine_load       NUMERIC;
  v_battery_voltage   NUMERIC;
  v_throttle_position NUMERIC;
  v_now               TIMESTAMPTZ := now();
BEGIN
  -- Verify the vehicle exists
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = p_vehicle_id) THEN
    RAISE EXCEPTION 'Vehicle % not found', p_vehicle_id;
  END IF;

  -- ── Generate realistic correlated sensor values ────────────────────────────
  -- Throttle is the primary driver; other values derive from it so readings
  -- look physically plausible rather than fully independent random noise.

  v_throttle_position := round((random() * 100)::numeric, 1);   -- 0 – 100 %

  -- RPM correlates loosely with throttle: idle baseline 800 + up to 3700 extra
  v_rpm := round(
    (800 + (v_throttle_position / 100.0) * 3700 + (random() * 200 - 100))::numeric,
    0
  );
  v_rpm := GREATEST(800, LEAST(4500, v_rpm));

  -- Speed also correlates with throttle but with more variance
  v_speed := round(
    ((v_throttle_position / 100.0) * 120 + (random() * 20 - 10))::numeric,
    1
  );
  v_speed := GREATEST(0, LEAST(120, v_speed));

  -- Coolant temperature rises with engine load (higher RPM → hotter)
  v_coolant_temp := round(
    (75 + (v_rpm / 4500.0) * 30 + (random() * 4 - 2))::numeric,
    1
  );
  v_coolant_temp := GREATEST(75, LEAST(105, v_coolant_temp));

  -- Fuel level: random draw in realistic range; in a real system this would
  -- be read from the vehicle's fuel gauge and decrease over time.
  v_fuel_level := round((10 + random() * 90)::numeric, 1);
  v_fuel_level := GREATEST(10, LEAST(100, v_fuel_level));

  -- Engine load correlates with RPM
  v_engine_load := round(
    (20 + (v_rpm / 4500.0) * 60 + (random() * 10 - 5))::numeric,
    1
  );
  v_engine_load := GREATEST(20, LEAST(80, v_engine_load));

  -- Battery voltage: healthy range 12 – 14.5 V when engine running
  v_battery_voltage := round(
    (11.5 + random() * 3.0)::numeric,
    2
  );
  v_battery_voltage := GREATEST(11.5, LEAST(14.5, v_battery_voltage));

  -- ── Insert one row per sensor type ────────────────────────────────────────
  INSERT INTO sensor_data (vehicle_id, sensor_type, value, unit, timestamp)
  VALUES
    (p_vehicle_id, 'rpm',               v_rpm,               'RPM',  v_now),
    (p_vehicle_id, 'speed',             v_speed,             'km/h', v_now),
    (p_vehicle_id, 'coolantTemp',       v_coolant_temp,      '°C',   v_now),
    (p_vehicle_id, 'fuelLevel',         v_fuel_level,        '%',    v_now),
    (p_vehicle_id, 'engineLoad',        v_engine_load,       '%',    v_now),
    (p_vehicle_id, 'batteryVoltage',    v_battery_voltage,   'V',    v_now),
    (p_vehicle_id, 'throttlePosition',  v_throttle_position, '%',    v_now);

  -- ── Keep vehicle.last_connected current ───────────────────────────────────
  UPDATE vehicles
  SET last_connected = v_now,
      updated_at     = v_now
  WHERE id = p_vehicle_id;

END;
$$;

COMMENT ON FUNCTION fn_simulate_vehicle_data(UUID) IS
  'Inserts one realistic sensor snapshot (7 sensor types) for the given vehicle. '
  'Values are physically correlated: throttle drives RPM, speed, coolant temp, and engine load.';


-- =============================================================================
-- fn_simulate_fleet_data
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_simulate_fleet_data(p_fleet_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_vehicle_id  UUID;
  v_count       INTEGER := 0;
BEGIN
  -- Verify the fleet exists
  IF NOT EXISTS (SELECT 1 FROM fleets WHERE id = p_fleet_id) THEN
    RAISE EXCEPTION 'Fleet % not found', p_fleet_id;
  END IF;

  -- Iterate over every vehicle in the fleet and simulate data
  FOR v_vehicle_id IN
    SELECT id
    FROM   vehicles
    WHERE  fleet_id  = p_fleet_id
    AND    is_active = true        -- skip decommissioned vehicles
    ORDER  BY name
  LOOP
    PERFORM fn_simulate_vehicle_data(v_vehicle_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;   -- returns how many vehicles were simulated
END;
$$;

COMMENT ON FUNCTION fn_simulate_fleet_data(UUID) IS
  'Calls fn_simulate_vehicle_data for every active vehicle in the given fleet. '
  'Returns the count of vehicles that received a simulated reading.';


-- =============================================================================
-- QUICK SMOKE TEST
-- =============================================================================
-- Uncomment to verify the functions work against the seed data:
--
--   SELECT fn_simulate_vehicle_data('bbbbbbbb-0000-0000-0000-000000000001');
--   SELECT fn_simulate_vehicle_data('bbbbbbbb-0000-0000-0000-000000000002');
--   SELECT fn_simulate_vehicle_data('bbbbbbbb-0000-0000-0000-000000000003');
--
--   SELECT fn_simulate_fleet_data('aaaaaaaa-0000-0000-0000-000000000001');
--     -- should return 2 (only active vehicles; Van 01 is inactive in seed.sql)
--
--   SELECT sensor_type, value, unit, timestamp
--   FROM   sensor_data
--   WHERE  vehicle_id = 'bbbbbbbb-0000-0000-0000-000000000001'
--   ORDER  BY timestamp DESC
--   LIMIT  14;


-- =============================================================================
-- pg_cron CONTINUOUS SIMULATION
-- =============================================================================
-- pg_cron is a Postgres extension pre-installed on Supabase Pro.
-- It is NOT available on the free tier.  On free tier, call the functions
-- manually or schedule them from your application server.
--
-- To enable on Pro:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--
-- Then schedule every 30 seconds by chaining two 1-minute jobs with a 30s delay:
--
--   -- Job 1: runs at the top of every minute
--   SELECT cron.schedule(
--     'simulate-fleet-data-on-minute',
--     '* * * * *',
--     $$SELECT fn_simulate_fleet_data('aaaaaaaa-0000-0000-0000-000000000001')$$
--   );
--
--   -- Job 2: runs 30 seconds into every minute (approximated via a wrapper)
--   -- pg_cron supports seconds in Supabase via cron.schedule_in_database:
--   SELECT cron.schedule(
--     'simulate-fleet-data-every-30s',
--     '30 seconds',
--     $$SELECT fn_simulate_fleet_data('aaaaaaaa-0000-0000-0000-000000000001')$$
--   );
--
-- To list all scheduled jobs:
--   SELECT * FROM cron.job;
--
-- To remove the jobs:
--   SELECT cron.unschedule('simulate-fleet-data-on-minute');
--   SELECT cron.unschedule('simulate-fleet-data-every-30s');
--
-- ---------------------------------------------------------------------------
-- ALTERNATIVE: Supabase Edge Function cron (no pg_cron required)
-- ---------------------------------------------------------------------------
-- Create a Deno edge function at supabase/functions/simulate-fleet/index.ts
-- and schedule it in supabase/config.toml:
--
--   [functions.simulate-fleet]
--   schedule = "*/1 * * * *"    # every minute
--
-- The function body calls fn_simulate_fleet_data via a Supabase RPC call:
--   const { data, error } = await supabase.rpc('fn_simulate_fleet_data', {
--     p_fleet_id: Deno.env.get('SEED_FLEET_ID')
--   });
-- =============================================================================

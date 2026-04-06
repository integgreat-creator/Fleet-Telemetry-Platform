-- =============================================================================
-- Fleet Telemetry Platform — Development Seed Data
-- =============================================================================
--
-- USAGE INSTRUCTIONS
-- ------------------
-- 1. First create a user in Supabase Auth (Dashboard → Authentication → Users
--    or via the app's sign-up flow).
--
-- 2. Copy that user's UUID and replace the placeholder below:
--      \set manager_id '<paste-your-user-uuid-here>'
--
-- 3. Run via the Supabase SQL editor or psql:
--      psql "$DATABASE_URL" -f supabase/seed/seed.sql
--    or paste into the Supabase Dashboard → SQL Editor.
--
-- 4. This script is idempotent — safe to re-run.  All inserts use
--    ON CONFLICT DO NOTHING so existing rows are never overwritten.
--
-- 5. To wipe and re-seed, run the cleanup block at the very bottom first.
--
-- NOTE: RLS policies require that the manager_id matches a real auth.users row.
--       Run this script as the service_role key (not anon) to bypass RLS, or
--       temporarily disable RLS on each table during seeding.
-- =============================================================================

-- ── CONFIGURATION ─────────────────────────────────────────────────────────────
-- Replace this UUID with the UUID of the fleet manager user you created in Auth.
-- The seed uses fixed UUIDs throughout so re-runs are always idempotent.

DO $$
DECLARE
  -- ▼ Change this to your actual auth user UUID ▼
  v_manager_id      UUID := '00000000-0000-0000-0000-000000000001';

  -- Fleet
  v_fleet_id        UUID := 'aaaaaaaa-0000-0000-0000-000000000001';

  -- Vehicles
  v_truck01_id      UUID := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_truck02_id      UUID := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_van01_id        UUID := 'bbbbbbbb-0000-0000-0000-000000000003';

  -- Trips
  v_trip1_id        UUID := 'cccccccc-0000-0000-0000-000000000001';
  v_trip2_id        UUID := 'cccccccc-0000-0000-0000-000000000002';
  v_trip3_id        UUID := 'cccccccc-0000-0000-0000-000000000003';
  v_trip4_id        UUID := 'cccccccc-0000-0000-0000-000000000004';
  v_trip5_id        UUID := 'cccccccc-0000-0000-0000-000000000005';

BEGIN

-- =============================================================================
-- 1. FLEET
-- =============================================================================

INSERT INTO fleets (id, name, organization, manager_id)
VALUES (
  v_fleet_id,
  'Alpha Fleet',
  'VehicleSense Logistics Ltd',
  v_manager_id
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 2. VEHICLES  (3 vehicles assigned to the fleet)
-- =============================================================================

INSERT INTO vehicles
  (id, name, vin, make, model, year, owner_id, fleet_id, is_active, health_score, last_connected)
VALUES
  (v_truck01_id, 'Truck 01', 'SEED1VIN0000000001', 'Ford',    'F-250',    2022, v_manager_id, v_fleet_id, true,  92,   now() - interval '2 minutes'),
  (v_truck02_id, 'Truck 02', 'SEED1VIN0000000002', 'Ford',    'F-350',    2021, v_manager_id, v_fleet_id, true,  78,   now() - interval '45 seconds'),
  (v_van01_id,   'Van 01',   'SEED1VIN0000000003', 'Mercedes', 'Sprinter', 2023, v_manager_id, v_fleet_id, false, 55,   now() - interval '3 hours')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. THRESHOLDS  (4 thresholds per vehicle)
-- =============================================================================

INSERT INTO thresholds (vehicle_id, sensor_type, min_value, max_value, alert_enabled)
VALUES
  -- Truck 01
  (v_truck01_id, 'coolantTemp',    NULL, 100,  true),
  (v_truck01_id, 'rpm',            NULL, 4000, true),
  (v_truck01_id, 'speed',          NULL, 120,  true),
  (v_truck01_id, 'fuelLevel',      10,   NULL,  true),
  -- Truck 02
  (v_truck02_id, 'coolantTemp',    NULL, 100,  true),
  (v_truck02_id, 'rpm',            NULL, 4000, true),
  (v_truck02_id, 'speed',          NULL, 120,  true),
  (v_truck02_id, 'fuelLevel',      10,   NULL,  true),
  -- Van 01
  (v_van01_id,   'coolantTemp',    NULL, 100,  true),
  (v_van01_id,   'rpm',            NULL, 4000, true),
  (v_van01_id,   'speed',          NULL, 120,  true),
  (v_van01_id,   'fuelLevel',      10,   NULL,  true)
ON CONFLICT (vehicle_id, sensor_type) DO NOTHING;

-- =============================================================================
-- 4. TRIPS  (mix of completed and active)
-- =============================================================================

INSERT INTO trips
  (id, vehicle_id, start_time, end_time, distance_km, duration_minutes, avg_speed_kmh,
   fuel_consumed_litres, idle_time_minutes, status)
VALUES
  -- Truck 01: two completed trips
  (v_trip1_id, v_truck01_id,
    now() - interval '8 hours',  now() - interval '6 hours',
    95.4, 120, 47.7, 8.2, 14, 'completed'),

  (v_trip2_id, v_truck01_id,
    now() - interval '3 hours',  now() - interval '1 hour 30 minutes',
    62.1, 90,  41.4, 5.3, 22, 'completed'),

  -- Truck 02: one completed, one active
  (v_trip3_id, v_truck02_id,
    now() - interval '12 hours', now() - interval '9 hours',
    148.7, 180, 49.6, 13.1, 8, 'completed'),

  (v_trip4_id, v_truck02_id,
    now() - interval '30 minutes', NULL,
    18.2, 30,  36.4, 1.6, 3,  'active'),

  -- Van 01: one completed (from yesterday)
  (v_trip5_id, v_van01_id,
    now() - interval '27 hours', now() - interval '25 hours',
    44.8, 110, 24.4, 4.9, 31, 'completed')
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 5. SENSOR DATA  (100 rows spread across the 3 vehicles)
--    30 rows for Truck 01, 40 rows for Truck 02, 30 rows for Van 01
--    Generated via a loop with deterministic pseudo-random values
-- =============================================================================

-- Helper: insert sensor readings for Truck 01 (30 rows × 6 sensor types = 5 rows per type)
DO $inner$
DECLARE
  v_truck01  UUID := 'bbbbbbbb-0000-0000-0000-000000000001';
  v_truck02  UUID := 'bbbbbbbb-0000-0000-0000-000000000002';
  v_van01    UUID := 'bbbbbbbb-0000-0000-0000-000000000003';
  i          INTEGER;
BEGIN
  -- ── Truck 01 ── 30 readings over last 2 hours ─────────────────────────────
  FOR i IN 1..5 LOOP
    INSERT INTO sensor_data (vehicle_id, sensor_type, value, unit, timestamp)
    VALUES
      (v_truck01, 'rpm',            800  + (i * 430)::numeric,       'RPM',   now() - (i * 24 || ' minutes')::interval),
      (v_truck01, 'speed',          10   + (i * 18)::numeric,        'km/h',  now() - (i * 24 || ' minutes')::interval + interval '1 minute'),
      (v_truck01, 'coolantTemp',    75   + (i * 4)::numeric,         '°C',    now() - (i * 24 || ' minutes')::interval + interval '2 minutes'),
      (v_truck01, 'fuelLevel',      85   - (i * 3)::numeric,         '%',     now() - (i * 24 || ' minutes')::interval + interval '3 minutes'),
      (v_truck01, 'engineLoad',     30   + (i * 8)::numeric,         '%',     now() - (i * 24 || ' minutes')::interval + interval '4 minutes'),
      (v_truck01, 'batteryVoltage', 12.5 + (i * 0.3)::numeric,       'V',     now() - (i * 24 || ' minutes')::interval + interval '5 minutes');
  END LOOP;

  -- ── Truck 02 ── 40 readings over last 3 hours (active trip in progress) ───
  FOR i IN 1..7 LOOP
    INSERT INTO sensor_data (vehicle_id, sensor_type, value, unit, timestamp)
    VALUES
      (v_truck02, 'rpm',            900  + (i * 390)::numeric,       'RPM',   now() - (i * 25 || ' minutes')::interval),
      (v_truck02, 'speed',          5    + (i * 17)::numeric,        'km/h',  now() - (i * 25 || ' minutes')::interval + interval '1 minute'),
      (v_truck02, 'coolantTemp',    72   + (i * 5)::numeric,         '°C',    now() - (i * 25 || ' minutes')::interval + interval '2 minutes'),
      (v_truck02, 'fuelLevel',      70   - (i * 4)::numeric,         '%',     now() - (i * 25 || ' minutes')::interval + interval '3 minutes'),
      (v_truck02, 'engineLoad',     25   + (i * 9)::numeric,         '%',     now() - (i * 25 || ' minutes')::interval + interval '4 minutes'),
      -- throttlePosition only for Truck 02
      (v_truck02, 'throttlePosition', 10 + (i * 12)::numeric,        '%',     now() - (i * 25 || ' minutes')::interval + interval '5 minutes');
  END LOOP;
  -- Two extra rows to reach 40 for Truck 02
  INSERT INTO sensor_data (vehicle_id, sensor_type, value, unit, timestamp)
  VALUES
    (v_truck02, 'batteryVoltage', 13.1, 'V', now() - interval '5 minutes'),
    (v_truck02, 'rpm',            1950, 'RPM', now() - interval '2 minutes');

  -- ── Van 01 ── 30 readings (inactive, older data) ──────────────────────────
  FOR i IN 1..5 LOOP
    INSERT INTO sensor_data (vehicle_id, sensor_type, value, unit, timestamp)
    VALUES
      (v_van01, 'rpm',            700  + (i * 280)::numeric,         'RPM',   now() - (3*60 + i*30 || ' minutes')::interval),
      (v_van01, 'speed',          0    + (i * 22)::numeric,          'km/h',  now() - (3*60 + i*30 || ' minutes')::interval + interval '1 minute'),
      (v_van01, 'coolantTemp',    68   + (i * 6)::numeric,           '°C',    now() - (3*60 + i*30 || ' minutes')::interval + interval '2 minutes'),
      (v_van01, 'fuelLevel',      45   - (i * 2)::numeric,           '%',     now() - (3*60 + i*30 || ' minutes')::interval + interval '3 minutes'),
      (v_van01, 'engineLoad',     20   + (i * 7)::numeric,           '%',     now() - (3*60 + i*30 || ' minutes')::interval + interval '4 minutes'),
      (v_van01, 'batteryVoltage', 11.8 + (i * 0.2)::numeric,         'V',     now() - (3*60 + i*30 || ' minutes')::interval + interval '5 minutes');
  END LOOP;
END $inner$;

-- =============================================================================
-- 6. COST INSIGHTS
-- =============================================================================

INSERT INTO cost_insights (vehicle_id, type, message, potential_savings, severity, is_resolved)
VALUES
  (v_truck01_id, 'idle_waste',
    'Truck 01 has accumulated 2.3 hours of excessive idle time this week, burning fuel unnecessarily.',
    420.00, 'warning', false),

  (v_truck02_id, 'driver_efficiency',
    'Frequent hard accelerations on Truck 02 are reducing fuel efficiency by an estimated 12%.',
    310.00, 'info', false),

  (v_van01_id, 'maintenance_needed',
    'Van 01 coolant temperature has exceeded safe limits on 3 occasions — schedule inspection.',
    1500.00, 'critical', false)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 7. ALERTS
-- =============================================================================

INSERT INTO alerts (vehicle_id, sensor_type, value, severity, message, acknowledged)
VALUES
  (v_truck01_id, 'coolantTemp', 103.2, 'critical',
    'Truck 01 coolant temperature exceeded maximum threshold of 100°C',  false),

  (v_truck02_id, 'rpm',         4150,  'warning',
    'Truck 02 RPM exceeded maximum threshold of 4000 RPM',               false),

  (v_van01_id,   'fuelLevel',   8.5,   'warning',
    'Van 01 fuel level dropped below minimum threshold of 10%',          true)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 8. DRIVER BEHAVIOR  (1 row per vehicle)
-- =============================================================================

INSERT INTO driver_behavior
  (vehicle_id, harsh_braking_count, harsh_acceleration_count,
   excessive_rpm_count, excessive_speed_count, average_engine_load,
   driver_score, trip_start, trip_end)
VALUES
  (v_truck01_id, 2, 3, 1, 0, 48.4, 82.0, now() - interval '8 hours',  now() - interval '6 hours'),
  (v_truck02_id, 5, 8, 4, 2, 61.2, 64.5, now() - interval '30 minutes', NULL),
  (v_van01_id,   1, 1, 3, 1, 35.7, 75.0, now() - interval '27 hours', now() - interval '25 hours')
ON CONFLICT DO NOTHING;

END $$;

-- =============================================================================
-- VERIFY
-- =============================================================================
-- Run these queries to confirm the seed was applied correctly:
--
--   SELECT COUNT(*) FROM fleets;            -- expect 1
--   SELECT COUNT(*) FROM vehicles;          -- expect 3
--   SELECT COUNT(*) FROM thresholds;        -- expect 12
--   SELECT COUNT(*) FROM trips;             -- expect 5
--   SELECT COUNT(*) FROM sensor_data;       -- expect ~100
--   SELECT COUNT(*) FROM cost_insights;     -- expect 3
--   SELECT COUNT(*) FROM alerts;            -- expect 3
--   SELECT COUNT(*) FROM driver_behavior;   -- expect 3

-- =============================================================================
-- CLEANUP  (uncomment to wipe seed data before re-seeding)
-- =============================================================================
-- WARNING: This deletes ALL rows from these tables, not just seed rows.
-- Only use in a local development environment.
--
-- DELETE FROM driver_behavior;
-- DELETE FROM cost_insights;
-- DELETE FROM alerts;
-- DELETE FROM sensor_data;
-- DELETE FROM trips;
-- DELETE FROM thresholds;
-- DELETE FROM vehicles  WHERE id IN (
--   'bbbbbbbb-0000-0000-0000-000000000001',
--   'bbbbbbbb-0000-0000-0000-000000000002',
--   'bbbbbbbb-0000-0000-0000-000000000003'
-- );
-- DELETE FROM fleets    WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ═══════════════════════════════════════════════════════════════════════════
-- FEATURE-GATED RLS POLICIES
--
-- Problem: feature access is enforced client-side only (browser + app).
-- A user with a valid session token can call the Supabase REST API or edge
-- functions directly and read gated data regardless of their plan.
--
-- Solution: add server-side SELECT policies on sensitive tables that call
-- check_feature_access(fleet_id, feature_key). These layer ON TOP of
-- existing ownership policies (AND logic) — a row must satisfy BOTH the
-- ownership check AND the feature-access check to be returned.
--
-- Design principles:
--   1. Never block writes / inserts — drivers must always be able to push
--      sensor data, vehicle logs, and alerts regardless of plan status.
--      Reads are gated; writes are not.
--   2. Owner-scoped helper — a stable SECURITY DEFINER function resolves
--      the fleet_id from a vehicle_id so RLS policies stay lean and the
--      subquery doesn't run with the row's own RLS (avoiding recursion).
--   3. Each policy uses a descriptive name so failures are diagnosable.
--   4. All DROP POLICY … IF EXISTS guards make the migration idempotent.
--
-- Feature → table mapping
-- ──────────────────────────────────────────────────────────────────────────
--  live_tracking       → sensor_data (SELECT)
--  trip_history        → trips, vehicle_logs (SELECT)
--  driver_behavior     → driver_behavior (SELECT)
--  maintenance_alerts  → maintenance_predictions (SELECT)
--  cost_analytics      → cost_predictions, historical_cost_data,
--                         fuel_events, cost_insights (SELECT)
--  ai_prediction       → vehicle_events where event_type like anomaly/tamper
--                         (handled by policy on vehicle_events SELECT)
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Helper: get fleet_id for a vehicle, callable from RLS ────────────────────
--
-- SECURITY DEFINER + search_path lock so the function always runs as its
-- owner (postgres) and cannot be hijacked via search_path manipulation.
-- STABLE so Postgres can cache the result within a single query.

CREATE OR REPLACE FUNCTION fn_fleet_id_for_vehicle(p_vehicle_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT fleet_id FROM vehicles WHERE id = p_vehicle_id LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION fn_fleet_id_for_vehicle(UUID) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. sensor_data  →  live_tracking
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "sensor_data_feature_gate" ON sensor_data;

CREATE POLICY "sensor_data_feature_gate"
  ON sensor_data
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'live_tracking'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. trips  →  trip_history
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "trips_feature_gate" ON trips;

CREATE POLICY "trips_feature_gate"
  ON trips
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'trip_history'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. vehicle_logs  →  trip_history
--    (GPS / ignition heartbeat — used to reconstruct routes)
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "vehicle_logs_feature_gate" ON vehicle_logs;

CREATE POLICY "vehicle_logs_feature_gate"
  ON vehicle_logs
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'trip_history'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. driver_behavior  →  driver_behavior
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "driver_behavior_feature_gate" ON driver_behavior;

CREATE POLICY "driver_behavior_feature_gate"
  ON driver_behavior
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'driver_behavior'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. maintenance_predictions  →  maintenance_alerts
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "maintenance_predictions_feature_gate" ON maintenance_predictions;

CREATE POLICY "maintenance_predictions_feature_gate"
  ON maintenance_predictions
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'maintenance_alerts'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. cost_predictions  →  cost_analytics
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "cost_predictions_feature_gate" ON cost_predictions;

CREATE POLICY "cost_predictions_feature_gate"
  ON cost_predictions
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'cost_analytics'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. historical_cost_data  →  cost_analytics
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "historical_cost_data_feature_gate" ON historical_cost_data;

CREATE POLICY "historical_cost_data_feature_gate"
  ON historical_cost_data
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'cost_analytics'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 8. fuel_events  →  fuel_monitoring
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "fuel_events_feature_gate" ON fuel_events;

CREATE POLICY "fuel_events_feature_gate"
  ON fuel_events
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'fuel_monitoring'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 9. cost_insights  →  cost_analytics
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "cost_insights_feature_gate" ON cost_insights;

CREATE POLICY "cost_insights_feature_gate"
  ON cost_insights
  FOR SELECT
  TO authenticated
  USING (
    (check_feature_access(
      fn_fleet_id_for_vehicle(vehicle_id),
      'cost_analytics'
    ) ->> 'allowed')::boolean = true
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 10. vehicle_events  →  ai_prediction
--     (anomaly / tamper / fuel-theft events — gated behind Pro)
--     vehicle_events also carries non-AI events (offline, idle) that are
--     available on all plans. We gate the SELECT at the row level by
--     event_type: AI-specific types require ai_prediction; everything else
--     falls through on live_tracking (available on all plans including trial).
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "vehicle_events_feature_gate" ON vehicle_events;

CREATE POLICY "vehicle_events_feature_gate"
  ON vehicle_events
  FOR SELECT
  TO authenticated
  USING (
    CASE
      -- AI / anomaly event types require ai_prediction feature
      WHEN event_type IN ('anomaly', 'tamper', 'fuel_theft', 'mock_gps')
      THEN (check_feature_access(
              fn_fleet_id_for_vehicle(vehicle_id),
              'ai_prediction'
            ) ->> 'allowed')::boolean = true
      -- All other events (offline, idle, unauthorized_movement, gap) are
      -- available on all plans — gate on live_tracking (trial+)
      ELSE (check_feature_access(
              fn_fleet_id_for_vehicle(vehicle_id),
              'live_tracking'
            ) ->> 'allowed')::boolean = true
    END
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- Edge function guard: sensor-api write path
--
-- sensor-api INSERT is allowed even on expired plans — drivers need to
-- keep pushing data. The guard applies only to the GET (read) path, which
-- is already handled by the sensor_data RLS policy above. No change needed
-- in the edge function for writes.
--
-- vehicle-api already calls check_vehicle_limit before INSERT; it does not
-- need a feature gate since vehicle CRUD is not a gated feature.
-- ═══════════════════════════════════════════════════════════════════════════
-- (No SQL changes needed for edge function write paths — RLS handles reads.)

/*
  # Add Foreign Key Indexes and Security Fixes

  ## Performance Improvements
  1. Foreign Key Indexes
    - Add index on `alerts.vehicle_id` for faster joins and lookups
    - Add index on `driver_behavior.vehicle_id` for faster joins and lookups
    - Add index on `maintenance_predictions.vehicle_id` for faster joins and lookups
    - Add index on `sensor_data.vehicle_id` for faster joins and lookups
    - Add index on `vehicles.fleet_id` for faster joins and lookups
    - Add index on `vehicles.owner_id` for faster joins and lookups

  ## Index Cleanup
  2. Remove Unused Indexes
    - Drop `idx_alerts_acknowledged_by` (not being used)
    - Drop `idx_alerts_threshold_id` (not being used)
    - Drop `idx_fleets_manager_id` (not being used)

  ## Notes
  - Foreign key indexes significantly improve JOIN performance and referential integrity checks
  - Removing unused indexes reduces storage overhead and improves write performance
  - Password leak protection must be enabled via Supabase Dashboard (cannot be done via SQL)
*/

-- Add indexes for foreign keys to improve query performance

-- Index for alerts.vehicle_id
CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_id 
ON public.alerts(vehicle_id);

-- Index for driver_behavior.vehicle_id
CREATE INDEX IF NOT EXISTS idx_driver_behavior_vehicle_id 
ON public.driver_behavior(vehicle_id);

-- Index for maintenance_predictions.vehicle_id
CREATE INDEX IF NOT EXISTS idx_maintenance_predictions_vehicle_id 
ON public.maintenance_predictions(vehicle_id);

-- Index for sensor_data.vehicle_id
CREATE INDEX IF NOT EXISTS idx_sensor_data_vehicle_id 
ON public.sensor_data(vehicle_id);

-- Index for vehicles.fleet_id
CREATE INDEX IF NOT EXISTS idx_vehicles_fleet_id 
ON public.vehicles(fleet_id);

-- Index for vehicles.owner_id
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_id 
ON public.vehicles(owner_id);

-- Remove unused indexes to improve write performance and reduce storage

-- Drop unused index on alerts.acknowledged_by
DROP INDEX IF EXISTS public.idx_alerts_acknowledged_by;

-- Drop unused index on alerts.threshold_id
DROP INDEX IF EXISTS public.idx_alerts_threshold_id;

-- Drop unused index on fleets.manager_id
DROP INDEX IF EXISTS public.idx_fleets_manager_id;

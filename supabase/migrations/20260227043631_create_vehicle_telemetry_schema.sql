/*
  # Vehicle Telemetry Platform Database Schema

  ## Overview
  Complete database schema for a vehicle telemetry platform supporting fleet management,
  real-time sensor monitoring, threshold alerts, and historical analytics.

  ## New Tables

  ### 1. `vehicles`
  Stores vehicle information and profiles
  - `id` (uuid, primary key)
  - `name` (text) - Vehicle nickname/identifier
  - `vin` (text, unique) - Vehicle Identification Number
  - `make` (text) - Vehicle manufacturer
  - `model` (text) - Vehicle model
  - `year` (integer) - Manufacturing year
  - `owner_id` (uuid) - References auth.users
  - `fleet_id` (uuid, nullable) - For fleet grouping
  - `is_active` (boolean) - Current active status
  - `health_score` (numeric) - Overall vehicle health (0-100)
  - `last_connected` (timestamptz) - Last connection timestamp
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 2. `sensor_data`
  Stores real-time sensor readings from vehicles
  - `id` (uuid, primary key)
  - `vehicle_id` (uuid) - References vehicles
  - `sensor_type` (text) - Type of sensor (rpm, speed, temperature, etc.)
  - `value` (numeric) - Sensor reading value
  - `unit` (text) - Unit of measurement
  - `timestamp` (timestamptz) - Reading timestamp
  - `created_at` (timestamptz)

  ### 3. `thresholds`
  Configurable alert thresholds for each vehicle and sensor
  - `id` (uuid, primary key)
  - `vehicle_id` (uuid) - References vehicles
  - `sensor_type` (text) - Sensor to monitor
  - `min_value` (numeric, nullable) - Minimum safe value
  - `max_value` (numeric, nullable) - Maximum safe value
  - `alert_enabled` (boolean) - Enable/disable alerts
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 4. `alerts`
  Historical log of all triggered alerts
  - `id` (uuid, primary key)
  - `vehicle_id` (uuid) - References vehicles
  - `sensor_type` (text) - Sensor that triggered alert
  - `threshold_id` (uuid) - References thresholds
  - `value` (numeric) - Value that triggered alert
  - `severity` (text) - warning, critical, info
  - `message` (text) - Alert description
  - `acknowledged` (boolean) - User acknowledgment status
  - `acknowledged_at` (timestamptz, nullable)
  - `acknowledged_by` (uuid, nullable) - References auth.users
  - `created_at` (timestamptz)

  ### 5. `fleets`
  Fleet groupings for multi-vehicle management
  - `id` (uuid, primary key)
  - `name` (text) - Fleet name
  - `organization` (text) - Company/organization name
  - `manager_id` (uuid) - References auth.users
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ### 6. `driver_behavior`
  Driver behavior analytics and scoring
  - `id` (uuid, primary key)
  - `vehicle_id` (uuid) - References vehicles
  - `trip_id` (uuid, nullable) - Optional trip grouping
  - `harsh_braking_count` (integer) - Number of harsh braking events
  - `harsh_acceleration_count` (integer) - Number of harsh accelerations
  - `excessive_rpm_count` (integer) - Times RPM exceeded safe limits
  - `excessive_speed_count` (integer) - Times speed exceeded limits
  - `average_engine_load` (numeric) - Average engine load percentage
  - `driver_score` (numeric) - Calculated driver score (0-100)
  - `trip_start` (timestamptz)
  - `trip_end` (timestamptz, nullable)
  - `created_at` (timestamptz)

  ### 7. `maintenance_predictions`
  AI-based maintenance predictions and recommendations
  - `id` (uuid, primary key)
  - `vehicle_id` (uuid) - References vehicles
  - `component` (text) - Component predicted to fail
  - `prediction_type` (text) - oil_change, brake_replacement, etc.
  - `confidence_score` (numeric) - Prediction confidence (0-1)
  - `predicted_date` (date) - Expected maintenance date
  - `miles_remaining` (numeric, nullable) - Estimated miles until service
  - `reasoning` (text) - AI reasoning/factors
  - `status` (text) - pending, scheduled, completed, dismissed
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz)

  ## Security
  - RLS enabled on all tables
  - Users can only access their own vehicles and data
  - Fleet managers can access all vehicles in their fleet
  - Separate policies for read, insert, update, delete operations

  ## Indexes
  - Created indexes on frequently queried columns for performance
  - Optimized for real-time sensor data queries and analytics
*/

-- Create fleets table
CREATE TABLE IF NOT EXISTS fleets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organization text NOT NULL,
  manager_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create vehicles table
CREATE TABLE IF NOT EXISTS vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  vin text UNIQUE NOT NULL,
  make text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  year integer DEFAULT 2020,
  owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL,
  is_active boolean DEFAULT true,
  health_score numeric DEFAULT 100 CHECK (health_score >= 0 AND health_score <= 100),
  last_connected timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create sensor_data table
CREATE TABLE IF NOT EXISTS sensor_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  sensor_type text NOT NULL,
  value numeric NOT NULL,
  unit text NOT NULL DEFAULT '',
  timestamp timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Create thresholds table
CREATE TABLE IF NOT EXISTS thresholds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  sensor_type text NOT NULL,
  min_value numeric,
  max_value numeric,
  alert_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(vehicle_id, sensor_type)
);

-- Create alerts table
CREATE TABLE IF NOT EXISTS alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  sensor_type text NOT NULL,
  threshold_id uuid REFERENCES thresholds(id) ON DELETE SET NULL,
  value numeric NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  acknowledged boolean DEFAULT false,
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);

-- Create driver_behavior table
CREATE TABLE IF NOT EXISTS driver_behavior (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  trip_id uuid,
  harsh_braking_count integer DEFAULT 0,
  harsh_acceleration_count integer DEFAULT 0,
  excessive_rpm_count integer DEFAULT 0,
  excessive_speed_count integer DEFAULT 0,
  average_engine_load numeric DEFAULT 0,
  driver_score numeric DEFAULT 100 CHECK (driver_score >= 0 AND driver_score <= 100),
  trip_start timestamptz DEFAULT now(),
  trip_end timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Create maintenance_predictions table
CREATE TABLE IF NOT EXISTS maintenance_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  component text NOT NULL,
  prediction_type text NOT NULL,
  confidence_score numeric CHECK (confidence_score >= 0 AND confidence_score <= 1),
  predicted_date date,
  miles_remaining numeric,
  reasoning text,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'completed', 'dismissed')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_sensor_data_vehicle_id ON sensor_data(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_sensor_data_timestamp ON sensor_data(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_data_vehicle_sensor ON sensor_data(vehicle_id, sensor_type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_id ON alerts(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vehicles_owner_id ON vehicles(owner_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_fleet_id ON vehicles(fleet_id);
CREATE INDEX IF NOT EXISTS idx_driver_behavior_vehicle_id ON driver_behavior(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_predictions_vehicle_id ON maintenance_predictions(vehicle_id);

-- Enable Row Level Security
ALTER TABLE fleets ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_behavior ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_predictions ENABLE ROW LEVEL SECURITY;

-- RLS Policies for fleets
CREATE POLICY "Fleet managers can view their own fleets"
  ON fleets FOR SELECT
  TO authenticated
  USING (manager_id = auth.uid());

CREATE POLICY "Fleet managers can create fleets"
  ON fleets FOR INSERT
  TO authenticated
  WITH CHECK (manager_id = auth.uid());

CREATE POLICY "Fleet managers can update their own fleets"
  ON fleets FOR UPDATE
  TO authenticated
  USING (manager_id = auth.uid())
  WITH CHECK (manager_id = auth.uid());

CREATE POLICY "Fleet managers can delete their own fleets"
  ON fleets FOR DELETE
  TO authenticated
  USING (manager_id = auth.uid());

-- RLS Policies for vehicles
CREATE POLICY "Users can view their own vehicles"
  ON vehicles FOR SELECT
  TO authenticated
  USING (
    owner_id = auth.uid() OR 
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "Users can create their own vehicles"
  ON vehicles FOR INSERT
  TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Users can update their own vehicles"
  ON vehicles FOR UPDATE
  TO authenticated
  USING (
    owner_id = auth.uid() OR 
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  )
  WITH CHECK (
    owner_id = auth.uid() OR 
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "Users can delete their own vehicles"
  ON vehicles FOR DELETE
  TO authenticated
  USING (owner_id = auth.uid());

-- RLS Policies for sensor_data
CREATE POLICY "Users can view sensor data for their vehicles"
  ON sensor_data FOR SELECT
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can insert sensor data for their vehicles"
  ON sensor_data FOR INSERT
  TO authenticated
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can delete sensor data for their vehicles"
  ON sensor_data FOR DELETE
  TO authenticated
  USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

-- RLS Policies for thresholds
CREATE POLICY "Users can view thresholds for their vehicles"
  ON thresholds FOR SELECT
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can create thresholds for their vehicles"
  ON thresholds FOR INSERT
  TO authenticated
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can update thresholds for their vehicles"
  ON thresholds FOR UPDATE
  TO authenticated
  USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  )
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can delete thresholds for their vehicles"
  ON thresholds FOR DELETE
  TO authenticated
  USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

-- RLS Policies for alerts
CREATE POLICY "Users can view alerts for their vehicles"
  ON alerts FOR SELECT
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can create alerts for their vehicles"
  ON alerts FOR INSERT
  TO authenticated
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can update alerts for their vehicles"
  ON alerts FOR UPDATE
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

-- RLS Policies for driver_behavior
CREATE POLICY "Users can view driver behavior for their vehicles"
  ON driver_behavior FOR SELECT
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can insert driver behavior for their vehicles"
  ON driver_behavior FOR INSERT
  TO authenticated
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

-- RLS Policies for maintenance_predictions
CREATE POLICY "Users can view maintenance predictions for their vehicles"
  ON maintenance_predictions FOR SELECT
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can create maintenance predictions for their vehicles"
  ON maintenance_predictions FOR INSERT
  TO authenticated
  WITH CHECK (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid())
  );

CREATE POLICY "Users can update maintenance predictions for their vehicles"
  ON maintenance_predictions FOR UPDATE
  TO authenticated
  USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE 
        owner_id = auth.uid() OR 
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );
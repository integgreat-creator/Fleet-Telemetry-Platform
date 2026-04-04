-- Autonomous Fleet Cost Intelligence Schema Upgrade

-- 1. Create drivers table if not exists (extending profiles)
CREATE TABLE IF NOT EXISTS drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL,
  license_number text UNIQUE,
  phone text,
  email text UNIQUE,
  fleet_id uuid REFERENCES fleets(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 2. Create trips table for detailed tracking
CREATE TABLE IF NOT EXISTS trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  driver_id uuid REFERENCES drivers(id) ON DELETE SET NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  distance_km numeric DEFAULT 0,
  duration_minutes numeric DEFAULT 0,
  avg_speed_kmh numeric DEFAULT 0,
  fuel_consumed_litres numeric DEFAULT 0,
  idle_time_minutes numeric DEFAULT 0,
  start_location_lat numeric,
  start_location_lng numeric,
  end_location_lat numeric,
  end_location_lng numeric,
  status text DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  created_at timestamptz DEFAULT now()
);

-- 3. Create fuel_events table
CREATE TABLE IF NOT EXISTS fuel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  type text NOT NULL CHECK (type IN ('excessive_idle', 'fuel_theft', 'refuel')),
  timestamp timestamptz DEFAULT now(),
  value numeric NOT NULL, -- e.g. amount of fuel dropped or duration of idle
  message text,
  location_lat numeric,
  location_lng numeric,
  created_at timestamptz DEFAULT now()
);

-- 4. Create cost_insights table
CREATE TABLE IF NOT EXISTS cost_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  type text NOT NULL, -- e.g. 'idle_waste', 'maintenance_needed', 'driver_efficiency'
  message text NOT NULL,
  potential_savings numeric DEFAULT 0,
  severity text DEFAULT 'info',
  is_resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- 5. Extend vehicles table for cost parameters
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS fuel_price_per_litre numeric DEFAULT 100.0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS avg_km_per_litre numeric DEFAULT 15.0;

-- 6. Enable RLS
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE fuel_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_insights ENABLE ROW LEVEL SECURITY;

-- 7. Basic RLS Policies (Owner/Manager based)
CREATE POLICY "Users can view drivers in their fleet" ON drivers
  FOR SELECT TO authenticated USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "Users can view trips for their vehicles" ON trips
  FOR SELECT TO authenticated USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid() OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  );

CREATE POLICY "Users can view fuel events for their vehicles" ON fuel_events
  FOR SELECT TO authenticated USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid() OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  );

CREATE POLICY "Users can view cost insights for their vehicles" ON cost_insights
  FOR SELECT TO authenticated USING (
    vehicle_id IN (SELECT id FROM vehicles WHERE owner_id = auth.uid() OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  );

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_id ON trips(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_fuel_events_vehicle_id ON fuel_events(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_cost_insights_vehicle_id ON cost_insights(vehicle_id);

-- Route Optimization AI Schema Upgrade

-- 1. Create destinations table
CREATE TABLE IF NOT EXISTS destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 2. Create optimized_routes table
CREATE TABLE IF NOT EXISTS optimized_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id uuid REFERENCES fleets(id) ON DELETE CASCADE NOT NULL,
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  origin_lat numeric NOT NULL,
  origin_lng numeric NOT NULL,
  destination_id uuid REFERENCES destinations(id) ON DELETE CASCADE NOT NULL,
  route_geometry jsonb, -- Stores the coordinates for mapping
  estimated_distance_km numeric,
  estimated_duration_minutes numeric,
  traffic_score numeric, -- AI generated traffic congestion factor (1-10)
  fuel_efficiency_score numeric, -- AI generated (1-10)
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- 3. Create historical_traffic_data table for AI training/analysis
CREATE TABLE IF NOT EXISTS historical_traffic_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  latitude numeric NOT NULL,
  longitude numeric NOT NULL,
  congestion_level numeric NOT NULL, -- 0 to 1
  timestamp timestamptz DEFAULT now()
);

-- 4. Enable RLS
ALTER TABLE destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE optimized_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_traffic_data ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies
CREATE POLICY "Users can view destinations" ON destinations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Users can view routes for their fleet" ON optimized_routes
  FOR SELECT TO authenticated USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_optimized_routes_fleet_id ON optimized_routes(fleet_id);
CREATE INDEX IF NOT EXISTS idx_historical_traffic_loc ON historical_traffic_data(latitude, longitude);

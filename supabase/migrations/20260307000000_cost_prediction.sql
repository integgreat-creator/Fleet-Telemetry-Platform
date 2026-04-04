-- Cost Prediction AI Schema Upgrade

-- 1. Create cost_predictions table
CREATE TABLE IF NOT EXISTS cost_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  prediction_date timestamptz DEFAULT now(),
  forecast_period text NOT NULL CHECK (forecast_period IN ('monthly', 'quarterly', 'yearly')),
  estimated_fuel_cost numeric DEFAULT 0,
  estimated_maintenance_cost numeric DEFAULT 0,
  estimated_insurance_cost numeric DEFAULT 0,
  estimated_total_cost numeric DEFAULT 0,
  confidence_score numeric CHECK (confidence_score >= 0 AND confidence_score <= 1),
  factors jsonb, -- AI factors like 'predicted fuel price spike', 'upcoming heavy usage'
  created_at timestamptz DEFAULT now()
);

-- 2. Create historical_cost_data table for AI training
CREATE TABLE IF NOT EXISTS historical_cost_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid REFERENCES vehicles(id) ON DELETE CASCADE NOT NULL,
  date timestamptz NOT NULL,
  category text NOT NULL CHECK (category IN ('fuel', 'maintenance', 'insurance', 'other')),
  amount numeric NOT NULL,
  details text,
  created_at timestamptz DEFAULT now()
);

-- 3. Enable RLS
ALTER TABLE cost_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE historical_cost_data ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
CREATE POLICY "Users can view cost predictions for their vehicles" ON cost_predictions
  FOR SELECT TO authenticated USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE
        owner_id = auth.uid() OR
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

CREATE POLICY "Users can view historical cost data for their vehicles" ON historical_cost_data
  FOR SELECT TO authenticated USING (
    vehicle_id IN (
      SELECT id FROM vehicles WHERE
        owner_id = auth.uid() OR
        fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cost_predictions_vehicle_id ON cost_predictions(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_historical_cost_vehicle_id ON historical_cost_data(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_historical_cost_date ON historical_cost_data(date);

-- ─────────────────────────────────────────────────────────────────────────────
-- Add extended fields to the vehicles table that the mobile app uses.
-- All additions are safe (IF NOT EXISTS / nullable with defaults) so this
-- migration can be applied to both fresh installs and existing databases.
-- ─────────────────────────────────────────────────────────────────────────────

-- Fuel type (petrol / diesel / cng / ev)
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS fuel_type TEXT NOT NULL DEFAULT 'petrol'
  CHECK (fuel_type IN ('petrol', 'diesel', 'cng', 'ev'));

-- Running cost fields used for cost-prediction features
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS fuel_price_per_litre NUMERIC NOT NULL DEFAULT 100.0;
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS avg_km_per_litre NUMERIC NOT NULL DEFAULT 15.0;

-- EV / CNG capacity fields (nullable — only relevant for those fuel types)
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS battery_capacity_kwh NUMERIC;
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS cng_capacity_kg NUMERIC;

-- Back-fill existing rows that have NULL fuel_type (shouldn't happen after
-- the NOT NULL + DEFAULT above, but included for safety)
UPDATE vehicles
SET fuel_type = 'petrol'
WHERE fuel_type IS NULL;

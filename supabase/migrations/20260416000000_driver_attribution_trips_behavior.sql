-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- ❹  Add driver_account_id to trips table
--     Links each trip to the driver_accounts row of the driver who drove it.
--     Nullable — historical trips have no attribution (permanent gap, expected).
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS driver_account_id UUID
    REFERENCES driver_accounts(id) ON DELETE SET NULL;

-- Index for per-driver trip queries
CREATE INDEX IF NOT EXISTS idx_trips_driver_account_id
  ON trips(driver_account_id)
  WHERE driver_account_id IS NOT NULL;

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- ❻  Add driver_account_id to driver_behavior table
--     Allows the AI scoring engine to attribute behavior records to a specific
--     driver rather than only to a vehicle.
--     Nullable — historical records retain vehicle_id attribution as before.
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALTER TABLE driver_behavior
  ADD COLUMN IF NOT EXISTS driver_account_id UUID
    REFERENCES driver_accounts(id) ON DELETE SET NULL;

-- Index for per-driver scoring queries
CREATE INDEX IF NOT EXISTS idx_driver_behavior_driver_account_id
  ON driver_behavior(driver_account_id)
  WHERE driver_account_id IS NOT NULL;

-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-- RLS: allow fleet managers to read trip rows for their fleet's drivers
--      (driver_sessions already covers session RLS; this covers trips)
-- ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

-- No new RLS policies required:
--   • trips is already accessible to fleet managers via vehicle_id
--   • driver_behavior is already accessible to fleet managers via vehicle_id
--   The new driver_account_id column is purely additive.

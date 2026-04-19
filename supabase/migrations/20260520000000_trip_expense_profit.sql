-- ============================================================
-- Trip Expense & Profit Tracking
--
-- Adds:
--   • trip_expenses   — per-trip cost breakdown (fuel auto-calc, manual: toll/allowance/other)
--   • trip_revenue    — per-trip revenue entered by fleet manager
--   • trips columns   — total_revenue, total_expense, profit (pre-computed for fast list queries)
--   • vehicles column — maintenance_cost_per_km
--   • sync_trip_profit() function + triggers (auto-update trips.profit on any change)
--   • daily_profit_summary view
--   • vehicle_profit_ranking view
--
-- Safe to re-run: IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP … IF EXISTS everywhere.
-- ============================================================

-- ── 1. vehicles: add maintenance_cost_per_km ────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS maintenance_cost_per_km NUMERIC(8, 4) NOT NULL DEFAULT 2.0;

-- ── 2. trips: add pre-computed profit columns ─────────────────────────────────
-- Pre-computing avoids expensive per-row joins on large fleet list queries.
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_expense NUMERIC(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS profit        NUMERIC(10, 2) NOT NULL DEFAULT 0;

-- ── 3. trip_expenses ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_expenses (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID          NOT NULL REFERENCES trips(id)    ON DELETE CASCADE,
  vehicle_id        UUID          NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  fuel_cost         NUMERIC(10,2) NOT NULL DEFAULT 0,   -- auto-calculated from distance + config
  toll_cost         NUMERIC(10,2) NOT NULL DEFAULT 0,   -- manual input
  driver_allowance  NUMERIC(10,2) NOT NULL DEFAULT 0,   -- manual input
  maintenance_cost  NUMERIC(10,2) NOT NULL DEFAULT 0,   -- auto-calculated from distance × cost_per_km
  other_cost        NUMERIC(10,2) NOT NULL DEFAULT 0,   -- manual input
  notes             TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_trip_expenses_non_negative
    CHECK (fuel_cost >= 0 AND toll_cost >= 0 AND driver_allowance >= 0
           AND maintenance_cost >= 0 AND other_cost >= 0),
  CONSTRAINT trip_expenses_trip_unique UNIQUE (trip_id)
);

CREATE INDEX IF NOT EXISTS trip_expenses_trip_id_idx    ON trip_expenses (trip_id);
CREATE INDEX IF NOT EXISTS trip_expenses_vehicle_id_idx ON trip_expenses (vehicle_id);

-- ── 4. trip_revenue ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trip_revenue (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id     UUID          NOT NULL REFERENCES trips(id)    ON DELETE CASCADE,
  vehicle_id  UUID          NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  amount      NUMERIC(10,2) NOT NULL DEFAULT 0,
  description TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT chk_trip_revenue_non_negative CHECK (amount >= 0),
  CONSTRAINT trip_revenue_trip_unique UNIQUE (trip_id)
);

CREATE INDEX IF NOT EXISTS trip_revenue_trip_id_idx    ON trip_revenue (trip_id);
CREATE INDEX IF NOT EXISTS trip_revenue_vehicle_id_idx ON trip_revenue (vehicle_id);

-- ── 5. RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE trip_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_revenue  ENABLE ROW LEVEL SECURITY;

-- Fleet managers can read + write; drivers can only read their own vehicle's data.
DROP POLICY IF EXISTS "trip_expenses_fleet_access" ON trip_expenses;
CREATE POLICY "trip_expenses_fleet_access" ON trip_expenses
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
         OR  v.id IN (SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "trip_revenue_fleet_access" ON trip_revenue;
CREATE POLICY "trip_revenue_fleet_access" ON trip_revenue
  FOR ALL TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
         OR  v.id IN (SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      WHERE  v.fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
         OR  v.owner_id = auth.uid()
    )
  );

-- ── 6. sync_trip_profit() — keeps trips.profit in sync ───────────────────────
CREATE OR REPLACE FUNCTION sync_trip_profit(p_trip_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_revenue  NUMERIC(10,2) := 0;
  v_expenses NUMERIC(10,2) := 0;
BEGIN
  SELECT COALESCE(amount, 0)
  INTO   v_revenue
  FROM   trip_revenue
  WHERE  trip_id = p_trip_id;

  SELECT COALESCE(
    fuel_cost + toll_cost + driver_allowance + maintenance_cost + other_cost, 0
  )
  INTO   v_expenses
  FROM   trip_expenses
  WHERE  trip_id = p_trip_id;

  UPDATE trips
  SET    total_revenue = v_revenue,
         total_expense = v_expenses,
         profit        = v_revenue - v_expenses
  WHERE  id = p_trip_id;
END;
$$;

-- ── 7. Triggers — fire on any change to expenses or revenue ──────────────────
CREATE OR REPLACE FUNCTION _trig_sync_profit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_trip_profit(COALESCE(NEW.trip_id, OLD.trip_id));
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_expense_profit ON trip_expenses;
CREATE TRIGGER trg_expense_profit
  AFTER INSERT OR UPDATE OR DELETE ON trip_expenses
  FOR EACH ROW EXECUTE FUNCTION _trig_sync_profit();

DROP TRIGGER IF EXISTS trg_revenue_profit ON trip_revenue;
CREATE TRIGGER trg_revenue_profit
  AFTER INSERT OR UPDATE OR DELETE ON trip_revenue
  FOR EACH ROW EXECUTE FUNCTION _trig_sync_profit();

-- ── 8. daily_profit_summary view ─────────────────────────────────────────────
CREATE OR REPLACE VIEW daily_profit_summary AS
SELECT
  (t.start_time AT TIME ZONE 'Asia/Kolkata')::date  AS date,
  v.fleet_id,
  COUNT(t.id)                                        AS trip_count,
  COALESCE(SUM(t.total_revenue), 0)                  AS total_revenue,
  COALESCE(SUM(t.total_expense), 0)                  AS total_expense,
  COALESCE(SUM(t.profit),        0)                  AS net_profit,
  COALESCE(SUM(t.distance_km),   0)                  AS total_distance_km
FROM   trips t
JOIN   vehicles v ON v.id = t.vehicle_id
WHERE  t.status = 'completed'
GROUP  BY 1, 2;

-- ── 9. vehicle_profit_ranking view ───────────────────────────────────────────
CREATE OR REPLACE VIEW vehicle_profit_ranking AS
SELECT
  v.id        AS vehicle_id,
  v.name      AS vehicle_name,
  v.fleet_id,
  COUNT(t.id)                               AS completed_trips,
  COALESCE(SUM(t.total_revenue), 0)         AS total_revenue,
  COALESCE(SUM(t.total_expense), 0)         AS total_expense,
  COALESCE(SUM(t.profit),        0)         AS net_profit,
  ROUND(
    CASE WHEN COALESCE(SUM(t.total_revenue), 0) > 0
         THEN (COALESCE(SUM(t.profit), 0) / SUM(t.total_revenue)) * 100
         ELSE 0
    END, 1
  )                                          AS profit_margin_pct
FROM   vehicles v
LEFT JOIN trips t ON t.vehicle_id = v.id AND t.status = 'completed'
GROUP  BY v.id, v.name, v.fleet_id;

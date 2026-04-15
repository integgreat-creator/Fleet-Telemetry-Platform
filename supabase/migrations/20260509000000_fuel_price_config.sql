-- ═══════════════════════════════════════════════════════════════════════════
-- FUEL PRICE CONFIGURATION
--
-- Stores the current retail fuel price (INR / litre) in a single-row
-- system config table. The generate-predictions edge function reads this
-- instead of the static FUEL_PRICE_USD env variable.
--
-- Fleet managers update the price via the Admin page.
-- A future pg_cron job / edge function can automate daily updates
-- once an external fuel-price API key is available.
--
-- Default: ₹103 / litre (approximate TN retail petrol price, Apr 2026).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fuel_price_config (
  id               SERIAL      PRIMARY KEY,        -- always 1 row
  price_inr        NUMERIC(8, 2) NOT NULL DEFAULT 103.00,
  price_usd        NUMERIC(8, 4) NOT NULL DEFAULT 1.24,   -- derived, kept for edge fn convenience
  usd_to_inr_rate  NUMERIC(8, 2) NOT NULL DEFAULT 83.00,
  source           TEXT        NOT NULL DEFAULT 'manual', -- 'manual' | 'api'
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Seed exactly one row (safe to re-run)
INSERT INTO fuel_price_config (id, price_inr, price_usd, usd_to_inr_rate, source)
VALUES (1, 103.00, 1.24, 83.00, 'manual')
ON CONFLICT (id) DO NOTHING;

-- Only fleet managers / admins can update; everyone authenticated can read
ALTER TABLE fuel_price_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fuel_price_read"   ON fuel_price_config;
DROP POLICY IF EXISTS "fuel_price_update" ON fuel_price_config;

CREATE POLICY "fuel_price_read" ON fuel_price_config
  FOR SELECT TO authenticated
  USING (true);

-- Only managers of at least one fleet can update (prevents random drivers from changing it)
CREATE POLICY "fuel_price_update" ON fuel_price_config
  FOR UPDATE TO authenticated
  USING  (EXISTS (SELECT 1 FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM fleets WHERE manager_id = auth.uid()));

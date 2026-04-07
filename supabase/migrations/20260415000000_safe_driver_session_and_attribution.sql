-- ─────────────────────────────────────────────────────────────────────────────
-- Safe additive migration — no existing tables/columns modified destructively
-- All changes are nullable additions or brand-new tables
-- ─────────────────────────────────────────────────────────────────────────────

-- ── DB-1: driver_sessions table ───────────────────────────────────────────────
-- Tracks which driver is actively connected to which vehicle.
-- Created here as an additive table; wired into the app in a future phase.
CREATE TABLE IF NOT EXISTS driver_sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_account_id UUID        NOT NULL REFERENCES driver_accounts(id) ON DELETE CASCADE,
  vehicle_id        UUID        NOT NULL REFERENCES vehicles(id)         ON DELETE CASCADE,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,          -- NULL = session still active
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast "active session for a driver" lookup
CREATE INDEX IF NOT EXISTS idx_driver_sessions_driver
  ON driver_sessions(driver_account_id)
  WHERE ended_at IS NULL;

-- Index for fast "active sessions on a vehicle" lookup
CREATE INDEX IF NOT EXISTS idx_driver_sessions_vehicle
  ON driver_sessions(vehicle_id)
  WHERE ended_at IS NULL;

-- RLS: fleet managers can read sessions for their fleet's vehicles
ALTER TABLE driver_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Fleet managers can view their fleet's sessions"
  ON driver_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM vehicles v
      JOIN   fleets  f ON f.id = v.fleet_id
      WHERE  v.id    = driver_sessions.vehicle_id
      AND    f.manager_id = auth.uid()
    )
  );

CREATE POLICY "Drivers can view their own sessions"
  ON driver_sessions FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM driver_accounts da
      WHERE  da.id      = driver_sessions.driver_account_id
      AND    da.user_id = auth.uid()
    )
  );

-- ── DB-2: Add driver_account_id to sensor_data (nullable) ────────────────────
-- Allows each sensor reading to optionally be attributed to a specific driver.
-- Existing rows remain NULL — no data is altered.
ALTER TABLE sensor_data
  ADD COLUMN IF NOT EXISTS driver_account_id UUID
    REFERENCES driver_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sensor_data_driver
  ON sensor_data(driver_account_id)
  WHERE driver_account_id IS NOT NULL;

-- ── DB-3: Add driver_account_id to vehicle_logs (nullable) ───────────────────
-- Allows each GPS heartbeat to optionally be attributed to a specific driver.
-- Existing rows remain NULL — no data is altered.
ALTER TABLE vehicle_logs
  ADD COLUMN IF NOT EXISTS driver_account_id UUID
    REFERENCES driver_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_logs_driver
  ON vehicle_logs(driver_account_id)
  WHERE driver_account_id IS NOT NULL;

-- ── DB-4: Add first_login_at to driver_accounts (nullable) ───────────────────
-- Set to now() on the driver's first successful app login.
-- NULL = driver has never logged in (onboarding not yet completed).
ALTER TABLE driver_accounts
  ADD COLUMN IF NOT EXISTS first_login_at TIMESTAMPTZ DEFAULT NULL;

-- ── DB-5: Add one_time_login_token to driver_accounts ────────────────────────
-- Stores a secure one-time token included in the welcome email QR code.
-- Expires after 7 days. Cleared after first use.
ALTER TABLE driver_accounts
  ADD COLUMN IF NOT EXISTS one_time_login_token       TEXT        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS one_time_login_token_exp   TIMESTAMPTZ DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_accounts_login_token
  ON driver_accounts(one_time_login_token)
  WHERE one_time_login_token IS NOT NULL;

-- ── Grant: service role can read/write new columns ────────────────────────────
-- (service_role bypasses RLS by default; explicit grants only needed for anon/authenticated)
GRANT SELECT, INSERT, UPDATE ON driver_sessions TO authenticated;

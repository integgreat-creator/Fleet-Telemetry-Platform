-- ─────────────────────────────────────────────────────────────────────────────
-- Driver invitations & driver accounts
-- ─────────────────────────────────────────────────────────────────────────────

-- ── invitations ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id       UUID NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  fleet_name     TEXT NOT NULL,
  invite_token   TEXT NOT NULL UNIQUE,
  vehicle_name   TEXT NOT NULL,          -- friendly label e.g. "Truck 04"
  driver_phone   TEXT NOT NULL,
  driver_email   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','expired')),
  vehicle_id     UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '72 hours'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invitations_token    ON invitations(invite_token);
CREATE INDEX IF NOT EXISTS idx_invitations_fleet_id ON invitations(fleet_id);
CREATE INDEX IF NOT EXISTS idx_invitations_status   ON invitations(status);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

-- Fleet managers can do everything with their own fleet's invitations
CREATE POLICY "managers_manage_invitations"
  ON invitations FOR ALL TO authenticated
  USING  (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));

-- ── driver_accounts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_accounts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fleet_id   UUID NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  name       TEXT,
  phone      TEXT,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_driver_accounts_user_id  ON driver_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_driver_accounts_fleet_id ON driver_accounts(fleet_id);

ALTER TABLE driver_accounts ENABLE ROW LEVEL SECURITY;

-- Fleet managers can view all drivers in their fleet
CREATE POLICY "managers_view_fleet_drivers"
  ON driver_accounts FOR SELECT TO authenticated
  USING (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));

-- Drivers can read their own record
CREATE POLICY "drivers_view_own_account"
  ON driver_accounts FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Only edge functions (service role) insert/update driver_accounts
-- This prevents drivers from modifying other drivers' records

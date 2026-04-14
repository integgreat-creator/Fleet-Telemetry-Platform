-- ═══════════════════════════════════════════════════════════════════════════
-- API KEYS + WEBHOOK CONFIG
--
-- Enables Pro fleet managers to generate long-lived API keys for
-- programmatic access, and register a webhook URL for push notifications.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. api_keys ──────────────────────────────────────────────────────────────
--
-- key_hash : SHA-256 hex of the raw key (never store plain text)
-- key_prefix: first 10 chars of the raw key — shown in the UI as "vs_ab12cd…"
-- last_used_at: updated by edge functions when the key authenticates a request

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id     UUID NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,          -- e.g. "vs_ab12cd34" (first 10 chars)
  created_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the auth lookup path (edge function hashes incoming key → lookup)
CREATE INDEX IF NOT EXISTS api_keys_hash_idx    ON api_keys(key_hash)  WHERE revoked_at IS NULL;
-- Index for the management UI (list keys for a fleet)
CREATE INDEX IF NOT EXISTS api_keys_fleet_idx   ON api_keys(fleet_id)  WHERE revoked_at IS NULL;

-- RLS
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Fleet managers can see and manage their own fleet's keys
DROP POLICY IF EXISTS "api_keys_fleet_manager" ON api_keys;
CREATE POLICY "api_keys_fleet_manager"
  ON api_keys
  FOR ALL
  TO authenticated
  USING (
    fleet_id IN (
      SELECT id FROM fleets WHERE manager_id = auth.uid()
    )
  )
  WITH CHECK (
    fleet_id IN (
      SELECT id FROM fleets WHERE manager_id = auth.uid()
    )
  );


-- ── 2. webhook_config ────────────────────────────────────────────────────────
--
-- One row per fleet. VehicleSense POSTs subscription and alert events here.

CREATE TABLE IF NOT EXISTS webhook_config (
  fleet_id    UUID PRIMARY KEY REFERENCES fleets(id) ON DELETE CASCADE,
  webhook_url TEXT,
  secret      TEXT,                    -- optional HMAC secret for signature verification
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE webhook_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_config_fleet_manager" ON webhook_config;
CREATE POLICY "webhook_config_fleet_manager"
  ON webhook_config
  FOR ALL
  TO authenticated
  USING (
    fleet_id IN (
      SELECT id FROM fleets WHERE manager_id = auth.uid()
    )
  )
  WITH CHECK (
    fleet_id IN (
      SELECT id FROM fleets WHERE manager_id = auth.uid()
    )
  );

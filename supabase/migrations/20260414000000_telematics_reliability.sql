-- ═══════════════════════════════════════════════════════════════════════════
-- Telematics Reliability — vehicle_logs, vehicle_events, trip enhancements
-- ═══════════════════════════════════════════════════════════════════════════

-- ── vehicle_logs ────────────────────────────────────────────────────────────
-- Lightweight heartbeat table: GPS + ignition + speed every 15 seconds.
-- Separate from sensor_data to keep OBD telemetry and location data distinct.
-- Auto-deleted after 30 days via pg_cron.
CREATE TABLE IF NOT EXISTS vehicle_logs (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  speed            NUMERIC     DEFAULT 0,
  ignition_status  BOOLEAN     DEFAULT false,
  latitude         NUMERIC(10,7),
  longitude        NUMERIC(10,7),
  accuracy_metres  NUMERIC     DEFAULT 0,
  altitude         NUMERIC     DEFAULT 0,
  is_mock_gps      BOOLEAN     DEFAULT false,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_logs_vehicle_time
  ON vehicle_logs(vehicle_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_logs_timestamp
  ON vehicle_logs(timestamp DESC);

ALTER TABLE vehicle_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fleet_managers_view_vehicle_logs"
  ON vehicle_logs FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id FROM vehicles v
      JOIN fleets f ON f.id = v.fleet_id
      WHERE f.manager_id = auth.uid()
    )
  );

CREATE POLICY "drivers_insert_vehicle_logs"
  ON vehicle_logs FOR INSERT TO authenticated
  WITH CHECK (
    vehicle_id IN (
      SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "drivers_view_own_vehicle_logs"
  ON vehicle_logs FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid()
    )
  );

-- ── vehicle_events ──────────────────────────────────────────────────────────
-- System events: offline, tamper, unauthorized movement, idle, gaps, mock GPS.
-- Separate from alerts (threshold violations) — shown together on Alerts tab.
CREATE TABLE IF NOT EXISTS vehicle_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  fleet_id         UUID        REFERENCES fleets(id) ON DELETE CASCADE,
  event_type       TEXT        NOT NULL
                   CHECK (event_type IN (
                     'device_offline', 'device_tamper', 'unauthorized_movement',
                     'excessive_idle', 'trip_gap', 'mock_gps_detected',
                     'ignition_no_data', 'device_online'
                   )),
  severity         TEXT        NOT NULL DEFAULT 'warning'
                   CHECK (severity IN ('warning', 'critical')),
  title            TEXT        NOT NULL,
  description      TEXT        NOT NULL DEFAULT '',
  metadata         JSONB       DEFAULT '{}',
  whatsapp_sent    BOOLEAN     DEFAULT false,
  whatsapp_sent_at TIMESTAMPTZ,
  acknowledged     BOOLEAN     DEFAULT false,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  UUID        REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_vehicle_time
  ON vehicle_events(vehicle_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_fleet_unack
  ON vehicle_events(fleet_id, acknowledged, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vehicle_events_type
  ON vehicle_events(event_type, created_at DESC);

ALTER TABLE vehicle_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "managers_manage_vehicle_events"
  ON vehicle_events FOR ALL TO authenticated
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  )
  WITH CHECK (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

CREATE POLICY "drivers_view_own_vehicle_events"
  ON vehicle_events FOR SELECT TO authenticated
  USING (
    vehicle_id IN (
      SELECT vehicle_id FROM driver_accounts WHERE user_id = auth.uid()
    )
  );

-- Service role can always insert events (from edge functions)
CREATE POLICY "service_role_insert_vehicle_events"
  ON vehicle_events FOR INSERT TO service_role
  WITH CHECK (true);

CREATE POLICY "service_role_update_vehicle_events"
  ON vehicle_events FOR UPDATE TO service_role
  USING (true);

-- ── trips enhancements ──────────────────────────────────────────────────────
-- Add gap tracking and data confidence score to existing trips table.
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS gap_count              INTEGER  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gap_duration_minutes   NUMERIC  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data_confidence_score  NUMERIC
    CHECK (data_confidence_score >= 0 AND data_confidence_score <= 100);

-- ── fleets enhancement ──────────────────────────────────────────────────────
-- Add WhatsApp number for fleet manager notification.
ALTER TABLE fleets
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT DEFAULT NULL;

-- ── pg_cron: 30-day retention for vehicle_logs ──────────────────────────────
-- Runs daily at 02:00 UTC. Deletes records older than 30 days.
-- The email-before-delete is handled by the heartbeat-monitor edge function
-- which checks for records approaching 23 days and sends export emails.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'vehicle_logs_cleanup',
      '0 2 * * *',
      $cmd$DELETE FROM vehicle_logs WHERE timestamp < now() - INTERVAL '30 days'$cmd$
    );
  END IF;
END $$;

-- ── Realtime: enable vehicle_events for live dashboard updates ───────────────
ALTER PUBLICATION supabase_realtime ADD TABLE vehicle_events;

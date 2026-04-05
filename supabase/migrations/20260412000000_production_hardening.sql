-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTION HARDENING MIGRATION
-- Fixes: missing FK, missing indexes, adds audit/device/sensor/subscription
-- tables, auto-triggers for sensor registry and subscription creation
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Fix missing FK: driver_behavior.trip_id → trips.id ────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_driver_behavior_trip'
  ) THEN
    ALTER TABLE driver_behavior
      ADD CONSTRAINT fk_driver_behavior_trip
      FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 2. Performance indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trips_vehicle_status
  ON trips(vehicle_id, status);

CREATE INDEX IF NOT EXISTS idx_sensor_data_vehicle_type_time
  ON sensor_data(vehicle_id, sensor_type, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_vehicle_severity
  ON alerts(vehicle_id, severity, acknowledged);

CREATE INDEX IF NOT EXISTS idx_driver_behavior_vehicle_time
  ON driver_behavior(vehicle_id, created_at DESC);

-- ── 3. sensor_registry — auto-populated by trigger ───────────────────────
CREATE TABLE IF NOT EXISTS sensor_registry (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          UUID         NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  sensor_type         TEXT         NOT NULL,
  display_name        TEXT         NOT NULL DEFAULT '',
  unit                TEXT         NOT NULL DEFAULT '',
  polling_interval_ms INTEGER      NOT NULL DEFAULT 1000,
  is_active           BOOLEAN      NOT NULL DEFAULT true,
  min_normal          NUMERIC,
  max_normal          NUMERIC,
  first_seen_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  reading_count       BIGINT       NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, sensor_type)
);

CREATE INDEX IF NOT EXISTS idx_sensor_registry_vehicle_id
  ON sensor_registry(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_sensor_registry_last_seen
  ON sensor_registry(last_seen_at DESC);

ALTER TABLE sensor_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sensor_registry_select"
  ON sensor_registry FOR SELECT TO authenticated
  USING (vehicle_id IN (
    SELECT id FROM vehicles
    WHERE owner_id = auth.uid()
    OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  ));

-- Trigger: auto-upsert sensor_registry on every sensor_data insert
CREATE OR REPLACE FUNCTION fn_upsert_sensor_registry()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO sensor_registry
    (vehicle_id, sensor_type, display_name, unit, first_seen_at, last_seen_at, reading_count)
  VALUES
    (NEW.vehicle_id, NEW.sensor_type, NEW.sensor_type, COALESCE(NEW.unit,''), NEW.timestamp, NEW.timestamp, 1)
  ON CONFLICT (vehicle_id, sensor_type) DO UPDATE SET
    last_seen_at  = EXCLUDED.last_seen_at,
    reading_count = sensor_registry.reading_count + 1,
    unit = CASE WHEN EXCLUDED.unit != '' THEN EXCLUDED.unit ELSE sensor_registry.unit END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_upsert_sensor_registry ON sensor_data;
CREATE TRIGGER trg_upsert_sensor_registry
  AFTER INSERT ON sensor_data
  FOR EACH ROW EXECUTE FUNCTION fn_upsert_sensor_registry();

-- ── 4. device_health ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_health (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID        NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  device_type      TEXT        NOT NULL DEFAULT 'obd2'
                     CHECK (device_type IN ('obd2','esp32','gps','sim')),
  device_id        TEXT,
  firmware_version TEXT,
  signal_strength  INTEGER,    -- dBm, -100 to 0
  battery_level    NUMERIC,    -- 0-100%
  last_ping_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_online        BOOLEAN     NOT NULL DEFAULT true,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, device_type)
);

CREATE INDEX IF NOT EXISTS idx_device_health_vehicle_id
  ON device_health(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_device_health_last_ping
  ON device_health(last_ping_at DESC);

ALTER TABLE device_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "device_health_select"
  ON device_health FOR SELECT TO authenticated
  USING (vehicle_id IN (
    SELECT id FROM vehicles
    WHERE owner_id = auth.uid()
    OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  ));

-- ── 5. audit_logs ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  fleet_id      UUID        REFERENCES fleets(id) ON DELETE SET NULL,
  vehicle_id    UUID        REFERENCES vehicles(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  resource_type TEXT        NOT NULL,
  resource_id   UUID,
  old_values    JSONB,
  new_values    JSONB,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id    ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_fleet_id   ON audit_logs(fleet_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_vehicle_id ON audit_logs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_logs_select"
  ON audit_logs FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

-- ── 6. subscriptions ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id                 UUID        NOT NULL UNIQUE REFERENCES fleets(id) ON DELETE CASCADE,
  plan                     TEXT        NOT NULL DEFAULT 'free'
                             CHECK (plan IN ('free','starter','pro','enterprise')),
  status                   TEXT        NOT NULL DEFAULT 'trial'
                             CHECK (status IN ('active','inactive','suspended','trial')),
  max_vehicles             INTEGER     NOT NULL DEFAULT 3,
  max_drivers              INTEGER     NOT NULL DEFAULT 5,
  features                 JSONB       NOT NULL DEFAULT '{}',
  razorpay_subscription_id TEXT,
  razorpay_customer_id     TEXT,
  current_period_start     TIMESTAMPTZ,
  current_period_end       TIMESTAMPTZ,
  trial_ends_at            TIMESTAMPTZ DEFAULT (now() + INTERVAL '30 days'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_fleet_id
  ON subscriptions(fleet_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subscriptions_select"
  ON subscriptions FOR SELECT TO authenticated
  USING (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));

-- Trigger: auto-create free subscription when a fleet is created
CREATE OR REPLACE FUNCTION fn_create_fleet_subscription()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO subscriptions (fleet_id, plan, status, max_vehicles, max_drivers, trial_ends_at)
  VALUES (NEW.id, 'free', 'trial', 3, 5, now() + INTERVAL '30 days')
  ON CONFLICT (fleet_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_fleet_subscription ON fleets;
CREATE TRIGGER trg_create_fleet_subscription
  AFTER INSERT ON fleets
  FOR EACH ROW EXECUTE FUNCTION fn_create_fleet_subscription();

-- Backfill subscriptions for existing fleets
INSERT INTO subscriptions (fleet_id, plan, status, max_vehicles, max_drivers, trial_ends_at)
SELECT id, 'free', 'trial', 3, 5, now() + INTERVAL '30 days'
FROM fleets
ON CONFLICT (fleet_id) DO NOTHING;

-- ── 7. Helper view: fleet_vehicle_count ───────────────────────────────────
CREATE OR REPLACE VIEW fleet_vehicle_count AS
SELECT
  f.id AS fleet_id,
  f.name AS fleet_name,
  f.manager_id,
  COUNT(v.id) AS vehicle_count,
  s.max_vehicles,
  s.plan,
  s.status AS subscription_status,
  s.trial_ends_at,
  CASE WHEN COUNT(v.id) >= s.max_vehicles THEN true ELSE false END AS at_vehicle_limit
FROM fleets f
LEFT JOIN vehicles v ON v.fleet_id = f.id
LEFT JOIN subscriptions s ON s.fleet_id = f.id
GROUP BY f.id, f.name, f.manager_id, s.max_vehicles, s.plan, s.status, s.trial_ends_at;

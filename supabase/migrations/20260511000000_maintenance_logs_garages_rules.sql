-- ═══════════════════════════════════════════════════════════════════════════
-- MAINTENANCE MANAGEMENT SYSTEM — Phase 1 (Part A)
--
-- New tables:
--   maintenance_logs    – records of every completed service action
--   garages             – basic service-centre directory for nearby suggestions
--   maintenance_rules   – configurable service rules (mirrors/replaces hardcoded
--                         values in generate-predictions; function uses DB first,
--                         falls back to hardcoded when table is empty)
--
-- Depends on: vehicles, fleets (already created in earlier migrations)
-- ═══════════════════════════════════════════════════════════════════════════


-- ── 1. maintenance_logs ───────────────────────────────────────────────────────
-- Written when a user clicks "Mark as Serviced".
-- Used by generate-predictions as the authoritative last-service baseline.

CREATE TABLE IF NOT EXISTS maintenance_logs (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID          NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  fleet_id         UUID          NOT NULL REFERENCES fleets(id)   ON DELETE CASCADE,
  service_type     TEXT          NOT NULL,
    -- 'oil_change' | 'tire_rotation' | 'air_filter' | 'brake_inspection'
    -- | 'engine_check' | 'custom'
  service_date     DATE          NOT NULL DEFAULT CURRENT_DATE,
  odometer_km      NUMERIC(10,1),          -- odometer at time of service
  cost             NUMERIC(10,2),          -- total cost (INR)
  notes            TEXT,
  logged_by        UUID          REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS maintenance_logs_vehicle_idx
  ON maintenance_logs(vehicle_id);

CREATE INDEX IF NOT EXISTS maintenance_logs_vehicle_type_idx
  ON maintenance_logs(vehicle_id, service_type, service_date DESC);

CREATE INDEX IF NOT EXISTS maintenance_logs_fleet_idx
  ON maintenance_logs(fleet_id);

ALTER TABLE maintenance_logs ENABLE ROW LEVEL SECURITY;

-- Fleet managers can see and write logs for their fleet
DROP POLICY IF EXISTS "maintenance_logs_fleet_access" ON maintenance_logs;
CREATE POLICY "maintenance_logs_fleet_access" ON maintenance_logs
  FOR ALL TO authenticated
  USING  (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()))
  WITH CHECK (fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid()));


-- ── 2. garages ────────────────────────────────────────────────────────────────
-- Basic service-centre directory for nearby-garage suggestions.
-- Public read; only admins write (seeded data, not user-managed).

CREATE TABLE IF NOT EXISTS garages (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT          NOT NULL,
  city             TEXT          NOT NULL,
  state            TEXT,
  latitude         NUMERIC(10,7) NOT NULL,
  longitude        NUMERIC(10,7) NOT NULL,
  contact_number   TEXT,
  address          TEXT,
  services_offered JSONB         NOT NULL DEFAULT '[]',
    -- e.g. ["oil_change","tire_rotation","brake_inspection","engine_check"]
  is_active        BOOLEAN       NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS garages_city_idx   ON garages(city);
CREATE INDEX IF NOT EXISTS garages_active_idx ON garages(is_active) WHERE is_active = true;

ALTER TABLE garages ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read garages (public directory)
DROP POLICY IF EXISTS "garages_public_read" ON garages;
CREATE POLICY "garages_public_read" ON garages
  FOR SELECT TO authenticated
  USING (is_active = true);


-- ── 3. maintenance_rules ──────────────────────────────────────────────────────
-- Configurable rule definitions.  generate-predictions reads these first;
-- falls back to its hardcoded MAINTENANCE_RULES array when table is empty.
-- Fleet managers can add per-vehicle custom rules (vehicle_id NOT NULL)
-- or view the global defaults (vehicle_id IS NULL).

CREATE TABLE IF NOT EXISTS maintenance_rules (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id       UUID          REFERENCES vehicles(id) ON DELETE CASCADE,
    -- NULL = global default rule; NOT NULL = vehicle-specific override
  fleet_id         UUID          REFERENCES fleets(id)   ON DELETE CASCADE,
    -- NULL for global defaults seeded by the system
  service_type     TEXT          NOT NULL,
  description      TEXT,
  interval_km      NUMERIC(10,1),
  interval_days    INTEGER,
  urgency_near_km  NUMERIC(10,1),  -- km remaining → 'high'
  urgency_far_km   NUMERIC(10,1),  -- km remaining → 'medium'
  is_active        BOOLEAN       NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, service_type)   -- one rule per type per vehicle (or global)
);

CREATE INDEX IF NOT EXISTS maintenance_rules_vehicle_idx
  ON maintenance_rules(vehicle_id) WHERE vehicle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS maintenance_rules_global_idx
  ON maintenance_rules(service_type) WHERE vehicle_id IS NULL;

ALTER TABLE maintenance_rules ENABLE ROW LEVEL SECURITY;

-- Fleet managers can manage rules for their fleet's vehicles
DROP POLICY IF EXISTS "maintenance_rules_fleet_access" ON maintenance_rules;
CREATE POLICY "maintenance_rules_fleet_access" ON maintenance_rules
  FOR ALL TO authenticated
  USING (
    vehicle_id IS NULL   -- global defaults: everyone can read
    OR vehicle_id IN (
      SELECT id FROM vehicles
      WHERE fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  )
  WITH CHECK (
    vehicle_id IN (
      SELECT id FROM vehicles
      WHERE fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
    )
  );

-- Allow authenticated users to read global (vehicle_id IS NULL) rules
DROP POLICY IF EXISTS "maintenance_rules_global_read" ON maintenance_rules;
CREATE POLICY "maintenance_rules_global_read" ON maintenance_rules
  FOR SELECT TO authenticated
  USING (vehicle_id IS NULL AND is_active = true);


-- ── 4. Seed: global maintenance rules (mirrors hardcoded values) ──────────────

INSERT INTO maintenance_rules
  (vehicle_id, fleet_id, service_type, description,
   interval_km, interval_days, urgency_near_km, urgency_far_km)
VALUES
  (NULL, NULL, 'oil_change',       'Engine oil & filter replacement',         10000,  365,  1000,  2500),
  (NULL, NULL, 'tire_rotation',    'Rotate tyres to ensure even wear',          8000, NULL,   800,  2000),
  (NULL, NULL, 'air_filter',       'Engine air filter replacement',            20000,  365,  2000,  5000),
  (NULL, NULL, 'brake_inspection', 'Brake pad & rotor inspection',             30000, NULL,  3000,  7500),
  (NULL, NULL, 'engine_check',     'Full engine & emissions service',          50000,  730,  5000, 12000)
ON CONFLICT (vehicle_id, service_type) DO NOTHING;


-- ── 5. Seed: garages (10 major Indian cities) ─────────────────────────────────

INSERT INTO garages
  (name, city, state, latitude, longitude, contact_number, address, services_offered)
VALUES
  ('Pratap Auto Works',         'Mumbai',    'Maharashtra', 19.0760, 72.8777, '+91-22-26541234',
   'Shop 4, LBS Marg, Kurla West, Mumbai 400070',
   '["oil_change","tire_rotation","brake_inspection","air_filter"]'),

  ('Sri Balaji Motors',         'Chennai',   'Tamil Nadu',  13.0827, 80.2707, '+91-44-24332211',
   '12, Anna Salai, Triplicane, Chennai 600005',
   '["oil_change","tire_rotation","engine_check","brake_inspection","air_filter"]'),

  ('Delhi Service Hub',         'New Delhi', 'Delhi',       28.6139, 77.2090, '+91-11-23456789',
   'Plot 7, Industrial Area, Okhla Phase II, New Delhi 110020',
   '["oil_change","tire_rotation","air_filter","engine_check"]'),

  ('Bengaluru Auto Care',       'Bengaluru', 'Karnataka',   12.9716, 77.5946, '+91-80-22991100',
   '45, Hosur Road, Electronic City, Bengaluru 560100',
   '["oil_change","brake_inspection","tire_rotation","engine_check"]'),

  ('Hyderabad Fleet Services',  'Hyderabad', 'Telangana',   17.3850, 78.4867, '+91-40-23456780',
   'Survey No. 12, Uppal Main Road, Hyderabad 500039',
   '["oil_change","tire_rotation","brake_inspection","air_filter","engine_check"]'),

  ('Pune Motor Works',          'Pune',      'Maharashtra', 18.5204, 73.8567, '+91-20-26543210',
   'Gat No. 321, Hadapsar Industrial Estate, Pune 411013',
   '["oil_change","air_filter","tire_rotation","brake_inspection"]'),

  ('Kolkata AutoZone',          'Kolkata',   'West Bengal', 22.5726, 88.3639, '+91-33-22201234',
   '8B, Diamond Harbour Road, Behala, Kolkata 700034',
   '["oil_change","tire_rotation","engine_check"]'),

  ('Ahmedabad Service Station', 'Ahmedabad', 'Gujarat',     23.0225, 72.5714, '+91-79-26543222',
   'B-12, Vatva Industrial Area, Ahmedabad 382445',
   '["oil_change","brake_inspection","air_filter","tire_rotation"]'),

  ('Jaipur Fleet Workshop',     'Jaipur',    'Rajasthan',   26.9124, 75.7873, '+91-141-2223344',
   'K-9, Sitapura Industrial Area, Jaipur 302022',
   '["oil_change","tire_rotation","brake_inspection","engine_check"]'),

  ('Kochi Auto Solutions',      'Kochi',     'Kerala',       9.9312, 76.2673, '+91-484-2345678',
   'NH-66, Edapally, Kochi 682024',
   '["oil_change","tire_rotation","air_filter","brake_inspection","engine_check"]')
ON CONFLICT DO NOTHING;

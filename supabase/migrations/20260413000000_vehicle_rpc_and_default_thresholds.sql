-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: create_vehicle_for_driver
-- Called by mobile app after OBD connection to register the vehicle.
-- Uses SECURITY DEFINER so the driver (limited RLS) can insert into vehicles
-- on behalf of their fleet manager.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION seed_default_thresholds(p_vehicle_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO thresholds (vehicle_id, sensor_type, min_value, max_value, alert_enabled)
  VALUES
    (p_vehicle_id, 'rpm',               500,   6500,  true),
    (p_vehicle_id, 'speed',               0,    120,  true),
    (p_vehicle_id, 'coolant_temp',       60,    110,  true),
    (p_vehicle_id, 'fuel_level',         10,    100,  true),
    (p_vehicle_id, 'battery_voltage',  11.5,   15.0,  true),
    (p_vehicle_id, 'engine_load',         0,     90,  true),
    (p_vehicle_id, 'throttle_position',   0,    100,  false),
    (p_vehicle_id, 'intake_air_temp',   -10,     65,  true),
    (p_vehicle_id, 'maf',                 0,    250,  false),
    (p_vehicle_id, 'short_fuel_trim_1', -25,     25,  true),
    (p_vehicle_id, 'long_fuel_trim_1',  -25,     25,  true),
    (p_vehicle_id, 'timing_advance',    -10,     40,  false),
    (p_vehicle_id, 'fuel_pressure',     250,    450,  true),
    (p_vehicle_id, 'map',                20,    200,  false),
    (p_vehicle_id, 'catalyst_temp_b1s1',  0,    800,  true),
    (p_vehicle_id, 'o2_voltage_b1s1',   0.1,    0.9,  false),
    (p_vehicle_id, 'o2_voltage_b1s2',   0.1,    0.9,  false)
  ON CONFLICT (vehicle_id, sensor_type) DO NOTHING;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_vehicle_for_driver(
  p_vin       TEXT,
  p_name      TEXT,
  p_make      TEXT    DEFAULT NULL,
  p_model     TEXT    DEFAULT NULL,
  p_year      INT     DEFAULT NULL,
  p_fuel_type TEXT    DEFAULT 'petrol',
  p_fleet_id  UUID    DEFAULT NULL
)
RETURNS vehicles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_vehicle    vehicles;
  v_manager_id UUID;
  v_is_new     BOOLEAN := false;
BEGIN
  -- Resolve fleet manager as the vehicle owner
  IF p_fleet_id IS NOT NULL THEN
    SELECT manager_id INTO v_manager_id
    FROM   fleets
    WHERE  id = p_fleet_id;
  END IF;

  -- Fall back to the calling user if no fleet
  IF v_manager_id IS NULL THEN
    v_manager_id := auth.uid();
  END IF;

  -- Try to find an existing vehicle with this VIN in this fleet
  SELECT * INTO v_vehicle
  FROM   vehicles
  WHERE  vin = p_vin
    AND  (fleet_id = p_fleet_id OR (fleet_id IS NULL AND p_fleet_id IS NULL))
  LIMIT 1;

  IF FOUND THEN
    -- Update only if we now have richer info than before
    UPDATE vehicles
    SET
      name       = CASE WHEN name IN ('My Vehicle', 'Pending Vehicle', '') THEN p_name ELSE name END,
      make       = COALESCE(p_make,  make),
      model      = COALESCE(p_model, model),
      year       = COALESCE(p_year,  year),
      updated_at = now()
    WHERE id = v_vehicle.id
    RETURNING * INTO v_vehicle;
  ELSE
    -- Insert new vehicle record
    INSERT INTO vehicles (
      vin, name, make, model, year,
      fuel_type, owner_id, fleet_id,
      is_active, health_score, created_at, updated_at
    )
    VALUES (
      p_vin, p_name, p_make, p_model, p_year,
      p_fuel_type, v_manager_id, p_fleet_id,
      true, 100.0, now(), now()
    )
    RETURNING * INTO v_vehicle;

    v_is_new := true;
  END IF;

  -- Link the calling driver to this vehicle in driver_accounts
  UPDATE driver_accounts
  SET    vehicle_id = v_vehicle.id
  WHERE  user_id   = auth.uid()
    AND  (fleet_id = p_fleet_id OR fleet_id IS NOT NULL);

  -- Seed default thresholds for brand-new vehicles only
  IF v_is_new THEN
    PERFORM seed_default_thresholds(v_vehicle.id);
  END IF;

  RETURN v_vehicle;
END;
$$;

-- Allow authenticated users (drivers) to call these functions
GRANT EXECUTE ON FUNCTION create_vehicle_for_driver(TEXT, TEXT, TEXT, TEXT, INT, TEXT, UUID)
  TO authenticated;
GRANT EXECUTE ON FUNCTION seed_default_thresholds(UUID)
  TO authenticated;

-- Ensure thresholds has a unique constraint on (vehicle_id, sensor_type) for the ON CONFLICT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'thresholds_vehicle_id_sensor_type_key'
  ) THEN
    ALTER TABLE thresholds ADD CONSTRAINT thresholds_vehicle_id_sensor_type_key
      UNIQUE (vehicle_id, sensor_type);
  END IF;
END $$;

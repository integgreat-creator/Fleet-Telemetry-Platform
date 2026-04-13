-- ═══════════════════════════════════════════════════════════════════════════
-- VEHICLE LIMIT ENFORCEMENT
-- Updates create_vehicle_for_driver RPC to call check_vehicle_limit()
-- before inserting a new vehicle. Existing vehicles are unaffected.
-- The mobile app receives a clear error message when the limit is hit.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_vehicle     vehicles;
  v_manager_id  UUID;
  v_is_new      BOOLEAN := false;
  v_limit_check JSONB;
BEGIN
  -- ── Resolve fleet manager ──────────────────────────────────────────────────
  IF p_fleet_id IS NOT NULL THEN
    SELECT manager_id INTO v_manager_id
    FROM   fleets
    WHERE  id = p_fleet_id;
  END IF;

  IF v_manager_id IS NULL THEN
    v_manager_id := auth.uid();
  END IF;

  -- ── Check if VIN already exists in this fleet (existing vehicle = no limit check) ──
  SELECT * INTO v_vehicle
  FROM   vehicles
  WHERE  vin = p_vin
    AND  (fleet_id = p_fleet_id OR (fleet_id IS NULL AND p_fleet_id IS NULL))
  LIMIT  1;

  -- Only enforce the vehicle limit when creating a brand-new vehicle.
  -- Reconnecting to an existing vehicle never counts against the limit.
  IF NOT FOUND THEN
    IF p_fleet_id IS NOT NULL THEN
      SELECT check_vehicle_limit(p_fleet_id) INTO v_limit_check;

      IF NOT (v_limit_check->>'allowed')::boolean THEN
        RAISE EXCEPTION '%', v_limit_check->>'reason'
          USING
            ERRCODE = 'P0001',
            HINT    = v_limit_check->>'plan';
      END IF;
    END IF;

    -- Insert new vehicle
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

  ELSE
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
  END IF;

  -- ── Link driver to vehicle ─────────────────────────────────────────────────
  UPDATE driver_accounts
  SET    vehicle_id = v_vehicle.id
  WHERE  user_id   = auth.uid()
    AND  (fleet_id = p_fleet_id OR fleet_id IS NOT NULL);

  -- ── Seed default thresholds for new vehicles only ─────────────────────────
  IF v_is_new THEN
    PERFORM seed_default_thresholds(v_vehicle.id);
  END IF;

  RETURN v_vehicle;
END;
$$;

-- Re-grant execute to authenticated users (SECURITY DEFINER functions
-- require explicit re-grant after every CREATE OR REPLACE)
GRANT EXECUTE ON FUNCTION create_vehicle_for_driver(TEXT, TEXT, TEXT, TEXT, INT, TEXT, UUID)
  TO authenticated;

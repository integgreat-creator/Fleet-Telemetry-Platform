-- ─────────────────────────────────────────────────────────────────────────────
-- Driver self-join workflow
--
-- Changes:
--   1. Add join_code to fleets (auto-generated 6-char code managers share
--      with drivers so drivers can join without a per-driver invite).
--   2. Allow any authenticated user to look up a fleet by join_code.
--   3. Allow drivers to INSERT their own driver_accounts row (self-join).
--   4. Backfill fleet_id on vehicles that were created by a fleet manager
--      directly (owner_id = manager_id) but never had fleet_id set.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. join_code on fleets ────────────────────────────────────────────────────

ALTER TABLE fleets ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;

-- Backfill existing fleets with a unique 6-char uppercase code
UPDATE fleets
SET join_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6))
WHERE join_code IS NULL;

ALTER TABLE fleets ALTER COLUMN join_code SET NOT NULL;

-- Auto-assign join_code for every new fleet
CREATE OR REPLACE FUNCTION assign_fleet_join_code()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.join_code IS NULL OR NEW.join_code = '' THEN
    NEW.join_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fleet_join_code ON fleets;
CREATE TRIGGER trg_fleet_join_code
  BEFORE INSERT ON fleets
  FOR EACH ROW EXECUTE FUNCTION assign_fleet_join_code();

-- ── 2. Allow any authenticated user to SELECT fleets (for join_code lookup) ──

-- Drop the existing manager-only SELECT policy so we can replace it with a
-- broader one that lets drivers search by join_code while managers still see
-- their own fleet details.
DROP POLICY IF EXISTS "Fleet managers can view their own fleets" ON fleets;
DROP POLICY IF EXISTS "managers_view_own_fleets" ON fleets;
DROP POLICY IF EXISTS "authenticated_lookup_fleet_by_join_code" ON fleets;

CREATE POLICY "managers_view_own_fleets"
  ON fleets FOR SELECT TO authenticated
  USING (manager_id = auth.uid());

-- Drivers (and any authenticated user) can look up the join_code and name
-- of any fleet so they can verify the code before joining.
CREATE POLICY "authenticated_lookup_fleet_by_join_code"
  ON fleets FOR SELECT TO authenticated
  USING (join_code IS NOT NULL);

-- ── 3. Allow drivers to self-INSERT into driver_accounts ─────────────────────
--
-- Previously only the service role (edge function) could insert here.
-- We now allow authenticated users to create their own row, scoped to
-- user_id = auth.uid() so no one can create a row for someone else.
--
-- Application logic (getFleetByJoinCode) validates the join_code before the
-- INSERT — the DB constraint is just a safety net.

DROP POLICY IF EXISTS "drivers_self_join_fleet" ON driver_accounts;

CREATE POLICY "drivers_self_join_fleet"
  ON driver_accounts FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND fleet_id IN (SELECT id FROM fleets WHERE join_code IS NOT NULL)
  );

-- ── 4. Backfill fleet_id on manager-owned vehicles ───────────────────────────
--
-- Vehicles created directly by a fleet manager via the web dashboard have
-- owner_id = manager_id but fleet_id = NULL.  The RLS policy allows the
-- manager to see them via owner_id, but the Admin / Alerts threshold queries
-- need fleet_id to be set so they can be scoped to the fleet.

UPDATE vehicles v
SET    fleet_id = f.id
FROM   fleets f
WHERE  v.owner_id  = f.manager_id
  AND  v.fleet_id  IS NULL;

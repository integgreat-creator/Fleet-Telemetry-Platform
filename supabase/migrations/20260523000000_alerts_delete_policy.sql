-- ─────────────────────────────────────────────────────────────────────────────
-- R1: Allow fleet managers to DELETE alerts for their fleet's vehicles.
--
-- Sensor alerts accumulate indefinitely without this policy.  Fleet managers
-- can now clear stale or resolved alerts from the dashboard.
--
-- Scope: only alerts whose vehicle belongs to a fleet the caller manages.
-- Drivers do NOT get delete access — they can only acknowledge.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "managers_delete_fleet_alerts" ON alerts;

CREATE POLICY "managers_delete_fleet_alerts"
  ON alerts FOR DELETE TO authenticated
  USING (
    vehicle_id IN (
      SELECT v.id
      FROM   vehicles v
      JOIN   fleets   f ON f.id = v.fleet_id
      WHERE  f.manager_id = auth.uid()
    )
  );

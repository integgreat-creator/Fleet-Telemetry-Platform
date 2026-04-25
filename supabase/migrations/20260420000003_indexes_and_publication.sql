-- ============================================================
-- Fix low-severity issues:
--   L1: Wrap ALTER PUBLICATION in safe DO block
--   L2: Add missing FK indexes on fuel_events, cost_insights
-- ============================================================

-- ── 1. Missing FK indexes (L2) ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS fuel_events_vehicle_id_idx
  ON fuel_events (vehicle_id);

CREATE INDEX IF NOT EXISTS cost_insights_vehicle_id_created_idx
  ON cost_insights (vehicle_id, created_at DESC);

-- ── 2. Realtime publication: add new tables safely (L1) ─────────────────────
-- Previous migration (20260329000001) used bare ALTER PUBLICATION which
-- errors if the publication doesn't exist. Wrap in a guarded DO block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    -- Add tables that are not yet part of the publication.
    -- Each ADD TABLE is idempotent in Postgres 15+ but we guard older versions.
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE cost_predictions;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE destinations;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE optimized_routes;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

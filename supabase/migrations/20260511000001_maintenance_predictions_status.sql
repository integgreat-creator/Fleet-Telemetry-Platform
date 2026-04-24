-- ═══════════════════════════════════════════════════════════════════════════
-- MAINTENANCE MANAGEMENT SYSTEM — Phase 1 (Part B)
--
-- Adds a `status` column to maintenance_predictions so the generate-
-- predictions function can mark predictions as upcoming / due / overdue /
-- completed without losing history.
--
-- CRITICAL DEPENDENCY: this migration MUST be applied before deploying the
-- updated generate-predictions edge function (Phase 2).  The updated function
-- uses .neq('status','completed') in its DELETE query — that query will error
-- if this column does not exist.
-- ═══════════════════════════════════════════════════════════════════════════

-- Add status column (safe: ADD COLUMN IF NOT EXISTS never breaks existing code)
ALTER TABLE maintenance_predictions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('upcoming', 'due', 'overdue', 'completed'));

-- No backfill needed: all existing rows default to 'upcoming', which is safe.
-- generate-predictions will assign the correct status (upcoming/due/overdue)
-- on its next run.  A backfill referencing `urgency` was removed because that
-- column may not exist in all deployed databases due to earlier schema drift.

-- Index for the common filter: non-completed predictions per vehicle
CREATE INDEX IF NOT EXISTS maint_pred_status_idx
  ON maintenance_predictions(vehicle_id, status)
  WHERE status != 'completed';

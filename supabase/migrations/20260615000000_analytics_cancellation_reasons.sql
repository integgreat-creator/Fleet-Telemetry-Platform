-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics_cancellation_reasons (Phase 3.10)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Aggregates the last 90 days of `subscription.cancellation_requested`
-- audit-log rows by reason bucket. Phase 3.2 had the customer pick from
-- a 6-value enum (too_expensive / missing_features / switching_competitor
-- / temporary_pause / just_exploring / other) and the cancel edge function
-- writes that into `audit_logs.new_values.reason`. Until now nothing
-- consumed it — ops + product needed "why are customers leaving?" but the
-- only path was a hand-rolled SQL.
--
-- Plain view (not materialized): audit_logs is small at our scale and the
-- WHERE on a 90-day window + indexed action+created_at filter is sub-ms.
-- Same approach as the funnel and cashback views.
--
-- Bucket definitions:
--   reason — the canonical enum value (from RECOGNISED_REASONS in the
--            cancel edge function). Server normalises typos to 'other',
--            so this column is always one of the 6 enum values.
--   count  — distinct fleets in this bucket. We dedupe by fleet_id
--            because a customer who cancels, resumes, then cancels again
--            shouldn't count twice toward "we lost N to too_expensive."
--   pct    — share of total cancellations in the window (0..100, two
--            decimals). Lets the dashboard render a horizontal stacked
--            bar without the client recomputing.
--
-- Depends on:
--   - 20260412000000_production_hardening.sql (audit_logs)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW analytics_cancellation_reasons AS
WITH window_cancels AS (
  -- One row per (fleet, reason) — the LATEST reason a fleet gave in the
  -- window. If they cancelled, resumed, and cancelled again with a
  -- different reason, the most recent intent is what counts.
  SELECT DISTINCT ON (fleet_id)
    fleet_id,
    COALESCE(NULLIF(new_values->>'reason', ''), 'other') AS reason
  FROM audit_logs
  WHERE action     = 'subscription.cancellation_requested'
    AND created_at >= (CURRENT_DATE - INTERVAL '90 days')
    AND fleet_id   IS NOT NULL
  ORDER BY fleet_id, created_at DESC
),
totals AS (
  SELECT COUNT(*)::INT AS total FROM window_cancels
)
SELECT
  reason,
  COUNT(*)::INT                                                AS count,
  ROUND(100.0 * COUNT(*) / NULLIF((SELECT total FROM totals), 0), 2)::NUMERIC AS pct
FROM window_cancels
GROUP BY reason
ORDER BY count DESC, reason;

COMMENT ON VIEW analytics_cancellation_reasons IS
  'Phase 3.10. Last 90 days of subscription.cancellation_requested audit '
  'rows aggregated by reason bucket, deduped to one row per fleet (most '
  'recent reason wins). Plain view — audit_logs is small enough.';

-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics_acquisition_breakdown (Phase 4.2)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Operator dashboard: per-acquisition-source rollup of fleet status,
-- MRR, and paid-conversion rate. Answers the founder questions:
--
--   "What % of MRR comes from referrals?"
--   "Are paid_social signups converting at the same rate as direct?"
--   "Should we keep spending on partner co-marketing?"
--
-- Reads from `analytics_subscription_mrr_per_row` (Phase 2.1) so the
-- monthly-equivalent revenue logic stays in one place — annual subs are
-- amortized to monthly the same way the global tile is.
--
-- Bucket counts:
--   trial_count       — currently on trial (no paid period yet)
--   paid_active_count — status='active' (contributing to MRR right now)
--   churned_count     — status in expired / inactive / suspended / paused.
--                       'paused' is included here because for revenue-attribution
--                       purposes a paused customer isn't currently paying.
--                       The cancellation reasons report (Phase 3.10) splits
--                       them differently for retention analysis.
--
-- Plain view, not materialized: at GTM scale this is sub-ms. Revisit if
-- the operator surface becomes part of a hot path.
--
-- Depends on:
--   - 20260605000000_analytics_views.sql                  (per-row MRR)
--   - 20260617000000_fleet_acquisition_source.sql         (fleets.acquisition_source)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW analytics_acquisition_breakdown AS
SELECT
  f.acquisition_source,

  -- Totals + status splits
  COUNT(*)                                                          AS total_fleets,
  COUNT(*) FILTER (WHERE s.status = 'trial')                        AS trial_count,
  COUNT(*) FILTER (WHERE s.status = 'active')                       AS paid_active_count,
  COUNT(*) FILTER (WHERE s.status IN
    ('expired','inactive','suspended','paused'))                    AS churned_count,

  -- MRR contribution from currently-active subs only. Trials/paused
  -- contribute zero by construction (effective_inr_per_month is null
  -- for trials anyway, and the FILTER excludes paused too).
  COALESCE(
    SUM(s.effective_inr_per_month) FILTER (WHERE s.status = 'active'),
    0
  )::NUMERIC(14,2)                                                  AS mrr_inr,

  -- Cohort paid-conversion rate: of all signups in this bucket, what
  -- % is currently paying? Useful for comparing source quality. Note
  -- this is a "currently paid" rate, not a "paid-ever" rate — a
  -- referral cohort that converted then cancelled lowers this number,
  -- which is the right behaviour for "what's working today".
  CASE
    WHEN COUNT(*) > 0 THEN
      ROUND(100.0 * COUNT(*) FILTER (WHERE s.status = 'active') / COUNT(*), 2)
    ELSE 0
  END::NUMERIC(5,2)                                                 AS paid_conversion_pct
FROM fleets f
JOIN analytics_subscription_mrr_per_row s ON s.fleet_id = f.id
GROUP BY f.acquisition_source
ORDER BY mrr_inr DESC, paid_active_count DESC, acquisition_source ASC;

COMMENT ON VIEW analytics_acquisition_breakdown IS
  'Phase 4.2. Per-acquisition-source rollup: fleet counts by status, '
  'MRR contribution, and paid-conversion rate. Reads through '
  'analytics_subscription_mrr_per_row so MRR math stays consistent '
  'with the global tile. Plain view — small joined cardinality.';

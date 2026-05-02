-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics_mrr_history (Phase 2.4)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Daily MRR series, last 90 days, reconstructed from the snapshot trail.
-- The snapshots table (Phase 2.3) already captures everything the live
-- per-row MRR formula needs — `billing_cycle`, `vehicle_count`,
-- `price_per_vehicle_inr`, `plan` — so historical MRR is a join + group-by
-- away.
--
-- Materialized for the same reason as `analytics_cohort_retention_curves`
-- (#81): joins + aggregates over `subscription_snapshots` grow linearly
-- with snapshot table size, and the daily granularity means recomputing
-- on every dashboard load is wasteful. Refreshes nightly at 00:35 UTC,
-- 5 min after the cohort-curves refresh — sequential helps cron logs read
-- in order.
--
-- Per-row MRR formula mirrors `analytics_subscription_mrr_per_row`:
--   - per_vehicle monthly:  vehicle_count × price_per_vehicle_inr
--   - per_vehicle annual:   above × (1 - annual_discount_pct/100)
--   - flat / custom monthly: plan_definitions.price_inr
--   - flat / custom annual:  above × (1 - annual_discount_pct/100)
--   - else: NULL (filtered out of the topline sum)
--
-- The annual case divides by 12 in the live view to get monthly-equivalent
-- MRR; we do the same here. ARR follows from MRR × 12, so the dashboard
-- doesn't need a second view.
--
-- Depends on:
--   - 20260607000000_subscription_snapshots.sql (snapshots table)
--   - 20260605000000_analytics_views.sql        (per-row MRR formula reference)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Drop existing (defensive against rerun) ─────────────────────────────

DROP VIEW              IF EXISTS analytics_mrr_history;
DROP MATERIALIZED VIEW IF EXISTS analytics_mrr_history;


-- ── 2. Materialized view: daily MRR + sub counts, last 90 days ─────────────

CREATE MATERIALIZED VIEW analytics_mrr_history AS
WITH window_days AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '89 days')::DATE,
    CURRENT_DATE::DATE,
    '1 day'::INTERVAL
  )::DATE AS day
),
snapshot_rows AS (
  -- One row per (day, fleet) with monthly-equivalent MRR worked out.
  -- Mirrors `analytics_subscription_mrr_per_row` from #74 but reads
  -- snapshots instead of live subscriptions so we can rebuild any past
  -- day. Annual subs are recognized as their per-month equivalent, same
  -- as MRR convention.
  SELECT
    ss.snapshot_date AS day,
    ss.fleet_id,
    ss.status,
    CASE
      WHEN pd.billing_model = 'per_vehicle'
           AND ss.billing_cycle = 'monthly'
           AND ss.vehicle_count IS NOT NULL
           AND ss.price_per_vehicle_inr IS NOT NULL
        THEN ss.vehicle_count * ss.price_per_vehicle_inr

      WHEN pd.billing_model = 'per_vehicle'
           AND ss.billing_cycle = 'annual'
           AND ss.vehicle_count IS NOT NULL
           AND ss.price_per_vehicle_inr IS NOT NULL
        THEN ROUND(
          ss.vehicle_count
          * ss.price_per_vehicle_inr
          * (1 - COALESCE(pd.annual_discount_pct, 0) / 100)
        , 2)

      WHEN ss.billing_cycle = 'monthly' AND pd.price_inr IS NOT NULL
        THEN pd.price_inr

      WHEN ss.billing_cycle = 'annual'  AND pd.price_inr IS NOT NULL
        THEN ROUND(
          pd.price_inr * (1 - COALESCE(pd.annual_discount_pct, 0) / 100)
        , 2)

      ELSE NULL
    END AS effective_inr_per_month
  FROM subscription_snapshots ss
  LEFT JOIN plan_definitions pd ON pd.plan_name = ss.plan
  WHERE ss.snapshot_date >= (CURRENT_DATE - INTERVAL '89 days')
)
SELECT
  d.day,
  COALESCE(SUM(sr.effective_inr_per_month) FILTER (
    WHERE sr.status = 'active' AND sr.effective_inr_per_month IS NOT NULL
  ), 0)::NUMERIC(14,2)                                    AS mrr_inr,
  COUNT(*) FILTER (
    WHERE sr.status = 'active' AND sr.effective_inr_per_month IS NOT NULL
  )                                                       AS paid_active_subs,
  COUNT(*) FILTER (WHERE sr.status = 'trial')             AS trial_active_subs,
  -- Frozen at REFRESH time, identical across every row. Surfaced via
  -- analytics-api as `mrr_history_materialized_at`.
  (now() AT TIME ZONE 'UTC')                              AS materialized_at
FROM window_days d
LEFT JOIN snapshot_rows sr ON sr.day = d.day
GROUP BY d.day
ORDER BY d.day
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW analytics_mrr_history IS
  '90-day daily MRR series. Reconstructed from subscription_snapshots × '
  'plan_definitions using the same per-row formula as the live MRR view. '
  'Days before snapshots existed (or with cron misses) yield zero MRR — '
  'the LEFT JOIN preserves the day, just with 0 sums. Refreshed nightly '
  'at 00:35 UTC.';


-- ── 3. Unique index for CONCURRENTLY refresh ────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS analytics_mrr_history_pk
  ON analytics_mrr_history (day);


-- ── 4. Initial populate ─────────────────────────────────────────────────────

REFRESH MATERIALIZED VIEW analytics_mrr_history;


-- ── 5. Daily refresh cron ───────────────────────────────────────────────────
-- 00:35 UTC. Cohort-curves cron is 00:30 UTC; sequential ordering helps
-- cron logs read top-down without needing to interleave timestamps.

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'analytics_mrr_history_refresh';

  PERFORM cron.schedule(
    'analytics_mrr_history_refresh',
    '35 0 * * *',
    $job$
    REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_mrr_history;
    $job$
  );
END
$$;

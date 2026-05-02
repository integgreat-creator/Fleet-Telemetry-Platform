-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics_mrr_history_by_plan (Phase 2.5)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Per-plan, per-day MRR for the last 90 days. Same shape as
-- `analytics_mrr_history` (#82) but grouped by `plan` as well as `day`,
-- so the dashboard can render a stacked-area chart showing MRR
-- composition over time — answers "is the new pricing tier gaining
-- traction" without needing the operator to interpret a single-line
-- topline.
--
-- Long format (one row per day × plan), not wide. Reasons:
--   * Plan names come from `plan_definitions`, which is mutable. Wide
--     format would bake the plan list into the schema; long format
--     handles new plans / renames without a migration.
--   * Dashboard pivots client-side using the dynamic plan list it
--     reads from the data itself. ~10 lines of TS.
--
-- Materialized + nightly-refreshed for the same reason as #81 / #82:
-- the snapshot table grows linearly, so does the join. Refresh at
-- 00:40 UTC, 5 min after the topline MRR refresh — sequential cron
-- ordering keeps logs readable.
--
-- Depends on:
--   - 20260610000000_analytics_mrr_history.sql        (per-row formula reference)
--   - 20260607000000_subscription_snapshots.sql       (snapshots table)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Drop existing (defensive against rerun) ─────────────────────────────

DROP VIEW              IF EXISTS analytics_mrr_history_by_plan;
DROP MATERIALIZED VIEW IF EXISTS analytics_mrr_history_by_plan;


-- ── 2. Materialized view: per-plan daily MRR, last 90 days ─────────────────

CREATE MATERIALIZED VIEW analytics_mrr_history_by_plan AS
WITH window_days AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '89 days')::DATE,
    CURRENT_DATE::DATE,
    '1 day'::INTERVAL
  )::DATE AS day
),
known_plans AS (
  -- Plans that appear ANYWHERE in the snapshot window. Drives the
  -- expected-pairs CROSS JOIN below — without it, plan-days that had
  -- zero subs would silently disappear, and the dashboard chart would
  -- shift its colour band as plans cycle in and out. Pinning the plan
  -- list to the window keeps the area chart stable.
  SELECT DISTINCT plan
  FROM subscription_snapshots
  WHERE snapshot_date >= (CURRENT_DATE - INTERVAL '89 days')
    AND plan IS NOT NULL
),
expected_pairs AS (
  SELECT d.day, p.plan
  FROM window_days d
  CROSS JOIN known_plans p
),
snapshot_rows AS (
  -- Per (day, fleet) monthly-equivalent MRR — same CASE expression as
  -- analytics_mrr_history, kept inline because PG doesn't have a
  -- table-valued function we'd want to call from a materialized view
  -- definition. If this drifts, also update 20260610000000.
  SELECT
    ss.snapshot_date AS day,
    ss.fleet_id,
    ss.plan,
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
  ep.day,
  ep.plan,
  COALESCE(SUM(sr.effective_inr_per_month) FILTER (
    WHERE sr.status = 'active' AND sr.effective_inr_per_month IS NOT NULL
  ), 0)::NUMERIC(14,2)                                     AS mrr_inr,
  COUNT(sr.fleet_id) FILTER (
    WHERE sr.status = 'active' AND sr.effective_inr_per_month IS NOT NULL
  )                                                        AS paid_active_subs,
  -- Frozen at REFRESH time. Identical across rows — read off the first
  -- row to populate `mrr_history_by_plan_materialized_at` in the API.
  (now() AT TIME ZONE 'UTC')                               AS materialized_at
FROM expected_pairs ep
LEFT JOIN snapshot_rows sr
  ON sr.day  = ep.day
 AND sr.plan = ep.plan
GROUP BY ep.day, ep.plan
ORDER BY ep.day, ep.plan
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW analytics_mrr_history_by_plan IS
  '90-day per-plan daily MRR series, long format (one row per day × plan). '
  'Plan list pinned to plans seen in the snapshot window so the dashboard '
  'area chart has stable colour bands. Refreshed nightly at 00:40 UTC.';


-- ── 3. Unique index for CONCURRENTLY refresh ────────────────────────────────
-- Composite (day, plan) is the natural key — at most one row per day-plan
-- pair, no duplicates from the GROUP BY.

CREATE UNIQUE INDEX IF NOT EXISTS analytics_mrr_history_by_plan_pk
  ON analytics_mrr_history_by_plan (day, plan);


-- ── 4. Initial populate ─────────────────────────────────────────────────────

REFRESH MATERIALIZED VIEW analytics_mrr_history_by_plan;


-- ── 5. Daily refresh cron ───────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'analytics_mrr_history_by_plan_refresh';

  PERFORM cron.schedule(
    'analytics_mrr_history_by_plan_refresh',
    '40 0 * * *',
    $job$
    REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_mrr_history_by_plan;
    $job$
  );
END
$$;

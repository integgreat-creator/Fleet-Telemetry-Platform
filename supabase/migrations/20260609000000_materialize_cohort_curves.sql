-- ════════════════════════════════════════════════════════════════════════════
-- Migration: materialize analytics_cohort_retention_curves
-- ════════════════════════════════════════════════════════════════════════════
--
-- Converts the one analytics view that's expensive enough to warrant
-- materialization. Selected because:
--
--   * Plain views in this surface (global_mrr, plan_distribution,
--     new_paid_subs_daily, conversion_funnel, cashback_roi) all aggregate
--     over `subscriptions` — small table, sub-ms even at GTM scale. Not
--     worth the refresh-cron operational burden.
--
--   * `analytics_cohort_retention_curves` is the exception. It does a
--     CROSS JOIN of cohorts × 12 month_offsets and a DISTINCT ON join
--     against `subscription_snapshots`. The snapshots table grows by
--     N_fleets rows per day — at month-12 of the SaaS that's ~365 × N
--     rows. This view's runtime grows linearly with that.
--
-- Refresh strategy:
--   * pg_cron at 00:30 UTC, after the 00:05 snapshot cron has had time
--     to land. Daily cadence matches snapshots' resolution — refreshing
--     more often wouldn't surface new data.
--   * REFRESH MATERIALIZED VIEW CONCURRENTLY (requires a unique index,
--     which we add). Dashboard reads stay live during the refresh
--     instead of blocking on an exclusive lock.
--   * `materialized_at` column is `now()` frozen at REFRESH time —
--     surfaces in the API response so the dashboard can show "Cohort
--     data as of X". Honest about staleness vs. the wall-clock-time
--     `generated_at` stamp the API already emits.
--
-- Future scaling note: if the plain views start showing query latency,
-- this migration is the template — DROP VIEW + CREATE MATERIALIZED VIEW
-- + unique index + cron. Don't materialize until measurable.
--
-- Depends on:
--   - 20260607000000_subscription_snapshots.sql (created the plain view)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Drop the existing plain view ─────────────────────────────────────────
-- The double-drop covers "rerunning the migration" — first run drops the
-- plain view from 20260607, subsequent reruns drop the materialized one.

DROP VIEW              IF EXISTS analytics_cohort_retention_curves;
DROP MATERIALIZED VIEW IF EXISTS analytics_cohort_retention_curves;


-- ── 2. Recreate as materialized view ────────────────────────────────────────
-- Body identical to the plain view except for the new `materialized_at`
-- column. WITH NO DATA so the migration apply doesn't pay the population
-- cost — the explicit REFRESH below handles that, and any error there is
-- recoverable without rolling back the migration.

CREATE MATERIALIZED VIEW analytics_cohort_retention_curves AS
WITH cohorts AS (
  SELECT
    date_trunc('month', s.current_period_start)::DATE AS cohort_month,
    s.fleet_id
  FROM subscriptions s
  WHERE s.current_period_start IS NOT NULL
    AND s.current_period_start >= (CURRENT_DATE - INTERVAL '12 months')
),
cohort_sizes AS (
  SELECT cohort_month, COUNT(*) AS size FROM cohorts GROUP BY cohort_month
),
month_offsets AS (
  SELECT generate_series(0, 11) AS offset_months
),
expected_pairs AS (
  SELECT
    c.cohort_month,
    o.offset_months,
    LEAST(
      (c.cohort_month + (o.offset_months || ' months')::INTERVAL)::DATE,
      CURRENT_DATE
    ) AS as_of_date,
    c.fleet_id
  FROM cohorts c
  CROSS JOIN month_offsets o
  WHERE (c.cohort_month + (o.offset_months || ' months')::INTERVAL)::DATE
        <= CURRENT_DATE
),
fleet_status_at_offset AS (
  SELECT DISTINCT ON (ep.cohort_month, ep.offset_months, ep.fleet_id)
    ep.cohort_month,
    ep.offset_months,
    ep.fleet_id,
    ss.status
  FROM expected_pairs ep
  LEFT JOIN subscription_snapshots ss
    ON ss.fleet_id      = ep.fleet_id
   AND ss.snapshot_date <= ep.as_of_date
  ORDER BY ep.cohort_month, ep.offset_months, ep.fleet_id, ss.snapshot_date DESC
)
SELECT
  fsa.cohort_month,
  fsa.offset_months,
  cs.size                                                 AS cohort_size,
  COUNT(*) FILTER (WHERE fsa.status = 'active')           AS active_count,
  ROUND(
    COUNT(*) FILTER (WHERE fsa.status = 'active')::NUMERIC
    / NULLIF(cs.size, 0) * 100,
    1
  )                                                       AS retention_pct,
  -- Frozen at REFRESH time — drives the dashboard's "Cohort data as of"
  -- subtitle. UTC for portability across deploy regions; the dashboard
  -- formats locally.
  (now() AT TIME ZONE 'UTC')                              AS materialized_at
FROM fleet_status_at_offset fsa
JOIN cohort_sizes cs ON cs.cohort_month = fsa.cohort_month
GROUP BY fsa.cohort_month, fsa.offset_months, cs.size
ORDER BY fsa.cohort_month DESC, fsa.offset_months ASC
WITH NO DATA;

COMMENT ON MATERIALIZED VIEW analytics_cohort_retention_curves IS
  'For each paid-cohort month (last 12), retention at month offsets 0..11. '
  'Materialized — refreshed daily at 00:30 UTC after the snapshot cron. '
  '`materialized_at` is now() frozen at REFRESH time, surfaced to the '
  'dashboard so the operator sees data freshness honestly.';


-- ── 3. Unique index for CONCURRENTLY refresh ────────────────────────────────
-- (cohort_month, offset_months) is the natural primary key — at most one
-- row per pair. Required for REFRESH CONCURRENTLY which keeps reads
-- non-blocking during the refresh.

CREATE UNIQUE INDEX IF NOT EXISTS analytics_cohort_retention_curves_pk
  ON analytics_cohort_retention_curves (cohort_month, offset_months);


-- ── 4. Initial populate ─────────────────────────────────────────────────────
-- WITH NO DATA above means the view is empty until the first REFRESH.
-- Doing it inline so the dashboard works immediately after the migration.
-- Non-CONCURRENTLY here because there's no concurrent reader — the view
-- was just created.

REFRESH MATERIALIZED VIEW analytics_cohort_retention_curves;


-- ── 5. Daily refresh cron ───────────────────────────────────────────────────

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'analytics_cohort_curves_refresh';

  PERFORM cron.schedule(
    'analytics_cohort_curves_refresh',
    -- 00:30 UTC. Snapshots cron runs at 00:05 UTC, vacuum + other midnight
    -- maintenance has typically settled by 00:30. CONCURRENTLY means the
    -- dashboard keeps reading old data during the refresh window — no
    -- blank-page incidents from a slow refresh.
    '30 0 * * *',
    $job$
    REFRESH MATERIALIZED VIEW CONCURRENTLY analytics_cohort_retention_curves;
    $job$
  );
END
$$;

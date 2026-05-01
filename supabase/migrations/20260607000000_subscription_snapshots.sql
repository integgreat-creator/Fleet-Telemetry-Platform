-- ════════════════════════════════════════════════════════════════════════════
-- Migration: subscription_snapshots + cohort retention curves (Phase 2.3)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Closes the gap left by Phase 2.2's cohort view: that one shows a single
-- retention point per cohort because we had no historical record of who
-- was active when. This migration captures that history daily and adds a
-- view that reads M0/M1/.../M11 retention curves out of it.
--
-- Cron: pg_cron writes one row per active+inactive subscription each day
-- at 00:05 UTC (≈ 05:35 IST — comfortably after the IST day rolls). The
-- INSERT is idempotent via a unique (fleet_id, snapshot_date) constraint,
-- so re-running the cron after a hiccup is safe.
--
-- Honesty: the historical curve fills in over TIME — at migration time,
-- only today has data, so old cohorts show only M0. Each subsequent day
-- adds one column of fidelity. The dashboard's empty-cell rendering makes
-- this self-evident; the PR body explains it for ops.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
--   - 20260501000000_subscription_system_v2.sql           (subscriptions)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. subscription_snapshots table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscription_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id        uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,

  -- The IST date the snapshot represents. Cron stores CURRENT_DATE which
  -- is server-local-time (Supabase Postgres runs UTC) — using a fixed
  -- 00:05 UTC schedule means snapshot_date always reflects the IST day
  -- that just ended. Documented inline in the cron schedule below.
  snapshot_date   DATE NOT NULL,

  -- Captured fields. Match what `analytics_subscription_mrr_per_row`
  -- consumes so future MRR-over-time computation can also read here.
  status          TEXT NOT NULL,
  plan            TEXT NOT NULL,
  billing_cycle   TEXT,
  vehicle_count   INTEGER,
  price_per_vehicle_inr  NUMERIC(10,2),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One snapshot per fleet per day. ON CONFLICT DO NOTHING in the cron
  -- makes re-runs safe.
  CONSTRAINT subscription_snapshots_unique
    UNIQUE (fleet_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS subscription_snapshots_date_idx
  ON subscription_snapshots (snapshot_date);

-- Hot path: "what was fleet X's status on or before date D" — the cohort
-- retention view does this with DISTINCT ON.
CREATE INDEX IF NOT EXISTS subscription_snapshots_fleet_date_idx
  ON subscription_snapshots (fleet_id, snapshot_date DESC);

COMMENT ON TABLE subscription_snapshots IS
  'Daily snapshot of every subscription row, keyed (fleet_id, snapshot_date). '
  'Powers cohort retention curves and (eventually) MRR-over-time. Populated '
  'by a 00:05-UTC pg_cron job; one row per fleet per day after the cron '
  'runs.';


-- ── 2. RLS — operator-only via service role; no customer-facing surface ────

ALTER TABLE subscription_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "no client access to subscription snapshots"
  ON subscription_snapshots;
CREATE POLICY "no client access to subscription snapshots"
  ON subscription_snapshots
  FOR ALL
  USING (false);


-- ── 3. Cron: daily snapshot insert ──────────────────────────────────────────
-- Idempotent. Re-running the cron after the operator restarts the worker
-- doesn't double-insert. Wrapped in a DO block so this migration is itself
-- re-runnable.

DO $$
BEGIN
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'subscription_snapshots_daily';

  PERFORM cron.schedule(
    'subscription_snapshots_daily',
    -- 00:05 UTC = 05:35 IST. Sits comfortably after the IST midnight roll
    -- so snapshot_date := CURRENT_DATE captures the day-that-just-ended in
    -- IST. The 5-minute offset gives any in-flight UTC-midnight DB work
    -- (other crons, vacuum) room to finish.
    '5 0 * * *',
    $job$
    INSERT INTO subscription_snapshots (
      fleet_id, snapshot_date, status, plan,
      billing_cycle, vehicle_count, price_per_vehicle_inr
    )
    SELECT
      fleet_id,
      CURRENT_DATE,
      status,
      plan,
      billing_cycle,
      vehicle_count,
      price_per_vehicle_inr
    FROM subscriptions
    ON CONFLICT (fleet_id, snapshot_date) DO NOTHING;
    $job$
  );
END
$$;


-- ── 4. Cohort retention curves view ──────────────────────────────────────────
-- For each cohort_month (= date_trunc('month', current_period_start)),
-- compute retention at month offsets 0..11. Reads from snapshots so we get
-- HISTORICAL "active at time T" data, not just "active right now".
--
-- The DISTINCT ON in fleet_status_at_offset graceful-degrades when a
-- snapshot for the exact target date is missing (e.g. cron miss): we walk
-- back to the most recent snapshot ≤ the target date. If a fleet has no
-- snapshots at all (cohort started before the snapshots table existed),
-- the LEFT JOIN yields NULL status and the fleet is correctly counted as
-- not-retained for that offset.

CREATE OR REPLACE VIEW analytics_cohort_retention_curves AS
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
  -- Each cohort × each offset that's already past = one expected
  -- (cohort, offset, fleet) tuple. We clamp the as_of_date to today so an
  -- offset that lands in the future just doesn't appear.
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
  -- Latest snapshot per (cohort, offset, fleet) at-or-before as_of_date.
  -- DISTINCT ON returns one row per group, picking the highest
  -- snapshot_date thanks to the matching ORDER BY.
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
  )                                                       AS retention_pct
FROM fleet_status_at_offset fsa
JOIN cohort_sizes cs ON cs.cohort_month = fsa.cohort_month
GROUP BY fsa.cohort_month, fsa.offset_months, cs.size
ORDER BY fsa.cohort_month DESC, fsa.offset_months ASC;

COMMENT ON VIEW analytics_cohort_retention_curves IS
  'For each paid-cohort month (last 12), retention at month offsets 0..11. '
  'Reads subscription_snapshots, so curves fill in over TIME — at this '
  'migration''s apply moment only M0 has data; each subsequent day adds '
  'one column of fidelity to all live cohorts.';

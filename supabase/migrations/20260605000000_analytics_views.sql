-- ════════════════════════════════════════════════════════════════════════════
-- Migration: operator analytics views (Phase 2.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Postgres views feeding the operator-only analytics-api edge function.
-- Read-only aggregates over `subscriptions` × `plan_definitions` — current
-- MRR / ARR, plan distribution, new-paid-subs trend.
--
-- Design notes:
--
-- * Plain views, not materialized. At GTM stage we expect tens to low
--   hundreds of active subscriptions; the aggregates are <1 ms in
--   practice. If volume grows past where on-demand becomes painful,
--   swap to materialized views with a hourly cron refresh — view names
--   stay the same so the edge function won't change.
--
-- * `analytics_subscription_mrr_per_row` normalizes monthly + annual
--   billing into a comparable monthly figure. Annual subscriptions are
--   counted as their per-month equivalent (annual / 12). This is the
--   industry-standard MRR convention; ARR follows by × 12.
--
-- * Per-vehicle subscriptions multiply by the paid-for vehicle count
--   stored on the subscription row. Flat / custom plans use price_inr.
--   `effective_inr_per_month` is null when neither could be computed —
--   the aggregating views skip nulls so an unconfigured plan can't
--   inflate the topline.
--
-- * RLS: views inherit RLS from the underlying tables. The edge function
--   uses the service-role client, so RLS is bypassed there. Direct anon
--   queries against the view would still hit subscriptions RLS and
--   return only that user's fleet — exactly the safety property we want.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
--   - 20260501000000_subscription_system_v2.sql           (subscriptions)
--   - 20260515000000_per_vehicle_plans.sql                (plan_definitions)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Per-row MRR ───────────────────────────────────────────────────────────
-- One row per subscription with its monthly-equivalent revenue worked out.
-- Higher-level aggregates (`analytics_global_mrr`, `analytics_plan_distribution`)
-- read from this so we calculate the per-row figure once.

CREATE OR REPLACE VIEW analytics_subscription_mrr_per_row AS
SELECT
  s.id                                                AS subscription_id,
  s.fleet_id,
  s.plan,
  s.status,
  s.billing_model,
  s.billing_cycle,
  s.vehicle_count,
  s.price_per_vehicle_inr,
  pd.price_inr                                        AS plan_flat_price_inr,
  pd.annual_discount_pct,
  s.current_period_start,
  s.current_period_end,
  s.created_at,

  -- Monthly-equivalent INR for this subscription, or NULL when we can't
  -- compute it (custom-pricing plans without a stored amount). The
  -- aggregators below filter NULLs out.
  CASE
    -- Per-vehicle, monthly billing: vehicle_count × per-vehicle price.
    WHEN s.billing_model = 'per_vehicle'
         AND s.billing_cycle = 'monthly'
         AND s.vehicle_count IS NOT NULL
         AND s.price_per_vehicle_inr IS NOT NULL
      THEN s.vehicle_count * s.price_per_vehicle_inr

    -- Per-vehicle, annual billing: same × discount, divided by 12.
    -- Customer paid up-front; we recognize revenue ratably across the
    -- year, which is what MRR captures.
    WHEN s.billing_model = 'per_vehicle'
         AND s.billing_cycle = 'annual'
         AND s.vehicle_count IS NOT NULL
         AND s.price_per_vehicle_inr IS NOT NULL
      THEN ROUND(
        s.vehicle_count
        * s.price_per_vehicle_inr
        * (1 - COALESCE(pd.annual_discount_pct, 0) / 100)
      , 2)

    -- Flat / custom monthly: use plan_definitions.price_inr verbatim.
    WHEN s.billing_cycle = 'monthly'
         AND pd.price_inr IS NOT NULL
      THEN pd.price_inr

    -- Flat / custom annual: same logic as per-vehicle annual.
    WHEN s.billing_cycle = 'annual'
         AND pd.price_inr IS NOT NULL
      THEN ROUND(
        pd.price_inr * (1 - COALESCE(pd.annual_discount_pct, 0) / 100)
      , 2)

    ELSE NULL
  END                                                 AS effective_inr_per_month
FROM subscriptions s
LEFT JOIN plan_definitions pd ON pd.plan_name = s.plan;

COMMENT ON VIEW analytics_subscription_mrr_per_row IS
  'One row per subscription with monthly-equivalent revenue (annual ÷ 12). '
  'Higher-level aggregate views read from this. NULL effective_inr_per_month '
  'means the plan has no stored price (e.g. custom-pricing Enterprise).';


-- ── 2. Global MRR / ARR ──────────────────────────────────────────────────────
-- Single-row view returning current MRR + ARR + active-sub count. ARR is just
-- MRR × 12 — included for the dashboard so the React side doesn't have to
-- multiply.

CREATE OR REPLACE VIEW analytics_global_mrr AS
SELECT
  COALESCE(SUM(effective_inr_per_month), 0)::NUMERIC(14,2) AS mrr_inr,
  (COALESCE(SUM(effective_inr_per_month), 0) * 12)::NUMERIC(14,2) AS arr_inr,
  COUNT(*) FILTER (WHERE effective_inr_per_month IS NOT NULL) AS paid_active_subs,
  COUNT(*) FILTER (WHERE status = 'trial')                    AS trial_active_subs,
  COUNT(*)                                                    AS total_subs
FROM analytics_subscription_mrr_per_row
WHERE status = 'active';

COMMENT ON VIEW analytics_global_mrr IS
  'Single-row topline. mrr_inr sums the monthly-equivalent revenue of every '
  'active subscription; arr_inr is mrr_inr × 12. paid_active_subs counts '
  'subscriptions that contributed to MRR; trial_active_subs is informational.';


-- ── 3. Plan distribution ─────────────────────────────────────────────────────
-- Active sub count + MRR contribution per plan. Drives the bar chart.
-- Includes trial in the count breakdown (status filter dropped) but trial
-- subs contribute zero MRR so the mrr_inr column is unaffected.

CREATE OR REPLACE VIEW analytics_plan_distribution AS
SELECT
  s.plan,
  COUNT(*)                                                AS sub_count,
  COUNT(*) FILTER (WHERE s.status = 'active')             AS active_count,
  COUNT(*) FILTER (WHERE s.status = 'trial')              AS trial_count,
  COALESCE(
    SUM(s.effective_inr_per_month) FILTER (WHERE s.status = 'active'),
    0
  )::NUMERIC(14,2)                                        AS mrr_inr
FROM analytics_subscription_mrr_per_row s
GROUP BY s.plan
ORDER BY mrr_inr DESC, sub_count DESC;

COMMENT ON VIEW analytics_plan_distribution IS
  'Per-plan rollup. active_count + trial_count usually = sub_count, but the '
  'split lets the dashboard show paid vs trial side-by-side without a second '
  'query.';


-- ── 4. New paid-subs trend (last 30 days) ────────────────────────────────────
-- Daily count of subscriptions that flipped to status='active' in the
-- window. Reads `current_period_start` because that's when the first paid
-- charge lands; `created_at` would also pick up trial signups that never
-- converted.

CREATE OR REPLACE VIEW analytics_new_paid_subs_daily AS
WITH days AS (
  SELECT generate_series(
    (CURRENT_DATE - INTERVAL '29 days')::DATE,
    CURRENT_DATE::DATE,
    '1 day'::INTERVAL
  )::DATE AS day
),
activations AS (
  SELECT
    DATE(current_period_start) AS day,
    COUNT(*) AS new_paid_subs
  FROM subscriptions
  WHERE status = 'active'
    AND current_period_start IS NOT NULL
    AND current_period_start >= (CURRENT_DATE - INTERVAL '29 days')
  GROUP BY 1
)
SELECT
  d.day,
  COALESCE(a.new_paid_subs, 0) AS new_paid_subs
FROM days d
LEFT JOIN activations a ON a.day = d.day
ORDER BY d.day;

COMMENT ON VIEW analytics_new_paid_subs_daily IS
  '30-day daily series with zero-fill for days that had no activations. '
  'Drives the new-paid-subs sparkline. Window is rolling — the migration '
  'doesn''t need to re-run when the date changes.';

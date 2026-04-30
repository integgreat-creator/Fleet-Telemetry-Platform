-- ════════════════════════════════════════════════════════════════════════════
-- Migration: conversion / cohort / cashback analytics views (Phase 2.2)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Three more views feeding the operator dashboard. Same plain-views-on-demand
-- pattern as Phase 2.1 — at GTM scale (10s–100s of subs) the queries are
-- cheap enough that materialization isn't worth the cron complexity.
--
-- Definitions:
--
-- * Funnel stages (last 90 days):
--     signed_up          — all subscriptions.created_at in window
--     trial_completed    — signed_up AND trial_ends_at <= now (i.e. trial
--                          period elapsed regardless of conversion)
--     paid_ever          — current_period_start IS NOT NULL
--     paid_now           — status = 'active'
--   conversion_rate = paid_ever / signed_up.
--
-- * Cohorts (paid_first_month → current retention):
--     A fleet's cohort = date_trunc('month', current_period_start). We
--     report cohort size (anyone who joined that month) and how many
--     are still status='active' today. That's a SINGLE retention point
--     per cohort, not a curve — true retention curves need historical
--     snapshots which we don't have yet (deferred to Phase 2.3).
--
-- * Cashback ROI:
--     Granted, redeemed, expired-unredeemed, and pending (unredeemed but
--     still in window). Redemption rate = redeemed_inr / granted_inr.
--
-- Depends on:
--   - 20260601000000_fleet_credits.sql               (fleet_credits)
--   - 20260605000000_analytics_views.sql             (precedent + style)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Conversion funnel (last 90 days) ─────────────────────────────────────

CREATE OR REPLACE VIEW analytics_conversion_funnel AS
WITH window_subs AS (
  SELECT
    s.plan,
    s.created_at,
    s.trial_ends_at,
    s.current_period_start,
    s.status
  FROM subscriptions s
  WHERE s.created_at >= (CURRENT_DATE - INTERVAL '90 days')
)
SELECT
  -- Overall row first (plan = NULL flag), then per-plan rows. The dashboard
  -- can split on plan IS NULL to show the topline funnel + per-plan breakdown.
  -- COALESCE keeps zero-row segments from disappearing.
  COALESCE(plan, '__overall__') AS plan,
  COUNT(*)                                                          AS signed_up,
  COUNT(*) FILTER (
    WHERE trial_ends_at IS NOT NULL AND trial_ends_at <= now()
  )                                                                 AS trial_completed,
  COUNT(*) FILTER (WHERE current_period_start IS NOT NULL)          AS paid_ever,
  COUNT(*) FILTER (WHERE status = 'active')                         AS paid_now
FROM window_subs
GROUP BY GROUPING SETS ((), (plan))
ORDER BY plan;

COMMENT ON VIEW analytics_conversion_funnel IS
  'Signup → paid funnel for the last 90 days. plan = ''__overall__'' is the '
  'topline aggregate; other rows split by plan_definitions.plan_name. The '
  'dashboard reads both and renders a stacked funnel.';


-- ── 2. Paid cohort retention (last 12 months) ────────────────────────────────

CREATE OR REPLACE VIEW analytics_paid_cohorts AS
WITH cohorts AS (
  SELECT
    date_trunc('month', s.current_period_start)::DATE AS cohort_month,
    s.fleet_id,
    s.status
  FROM subscriptions s
  WHERE s.current_period_start IS NOT NULL
    AND s.current_period_start >= (CURRENT_DATE - INTERVAL '12 months')
)
SELECT
  cohort_month,
  COUNT(*)                                       AS cohort_size,
  COUNT(*) FILTER (WHERE status = 'active')      AS retained_now,
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      (COUNT(*) FILTER (WHERE status = 'active'))::NUMERIC
      / COUNT(*)::NUMERIC * 100,
      1
    )
  END                                            AS retention_pct
FROM cohorts
GROUP BY cohort_month
ORDER BY cohort_month DESC;

COMMENT ON VIEW analytics_paid_cohorts IS
  'For each month a paid cohort started (current_period_start), how many of '
  'those fleets are still status=''active'' today. Single retention point per '
  'cohort, not a full curve — true curves need a daily subscription_snapshots '
  'table (deferred to Phase 2.3).';


-- ── 3. Cashback ROI ──────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW analytics_cashback_roi AS
SELECT
  -- Volume + total INR per state.
  COUNT(*)                                                 AS granted_count,
  COALESCE(SUM(amount_inr), 0)::NUMERIC(14,2)              AS granted_inr,

  COUNT(*) FILTER (WHERE redeemed_at IS NOT NULL)          AS redeemed_count,
  COALESCE(
    SUM(amount_inr) FILTER (WHERE redeemed_at IS NOT NULL),
    0
  )::NUMERIC(14,2)                                         AS redeemed_inr,

  COUNT(*) FILTER (
    WHERE redeemed_at IS NULL AND expires_at < now()
  )                                                        AS expired_count,
  COALESCE(
    SUM(amount_inr) FILTER (
      WHERE redeemed_at IS NULL AND expires_at < now()
    ),
    0
  )::NUMERIC(14,2)                                         AS expired_inr,

  COUNT(*) FILTER (
    WHERE redeemed_at IS NULL AND expires_at >= now()
  )                                                        AS pending_count,
  COALESCE(
    SUM(amount_inr) FILTER (
      WHERE redeemed_at IS NULL AND expires_at >= now()
    ),
    0
  )::NUMERIC(14,2)                                         AS pending_inr,

  -- Redemption rate as a percentage of total granted INR (not count).
  -- INR-weighted is more meaningful since cashback amounts vary widely
  -- (₹30 for an Essential first charge, ₹500 for a Business first charge).
  CASE
    WHEN COALESCE(SUM(amount_inr), 0) = 0 THEN 0
    ELSE ROUND(
      COALESCE(SUM(amount_inr) FILTER (WHERE redeemed_at IS NOT NULL), 0)::NUMERIC
      / SUM(amount_inr)::NUMERIC * 100,
      1
    )
  END                                                      AS redemption_pct
FROM fleet_credits;

COMMENT ON VIEW analytics_cashback_roi IS
  'Cashback program health. Tracks granted/redeemed/expired/pending splits in '
  'both count and INR. redemption_pct is INR-weighted because cashback '
  'amounts vary by plan size — a count-based rate would treat a ₹30 grant '
  'the same as a ₹500 one.';

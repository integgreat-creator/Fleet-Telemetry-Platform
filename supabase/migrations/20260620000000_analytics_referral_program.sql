-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics views for the referral program (Phase 4.8)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Two operator-facing views that consume the referrals table:
--
--   analytics_referral_program_roi       — single-row aggregate: granted
--                                          / redeemed / expired / pending
--                                          counts and INR. The dashboard
--                                          tile shows redemption % to
--                                          tell ops "is the program
--                                          actually paying customers
--                                          back, or are credits expiring
--                                          unused?"
--
--   analytics_top_referrers              — top-20 referrers by count.
--                                          Includes redeemed / expired
--                                          counts per referrer so ops
--                                          can spot a fleet whose
--                                          credits all expired (which
--                                          implies the referrer doesn't
--                                          renew often enough for the
--                                          credit to land — a UX signal,
--                                          not a fraud signal).
--
-- Both are plain views, not materialized. The referrals table is small
-- (one row per successful referral conversion) and the joins are
-- index-friendly. If volume crosses the materialize threshold, swap
-- alongside the cohort/MRR MVs.
--
-- Depends on:
--   - 20260619000000_referrals_table.sql    (referrals)
--   - 20260601000000_fleet_credits.sql      (fleet_credits)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Referral program ROI (single row) ───────────────────────────────────
CREATE OR REPLACE VIEW analytics_referral_program_roi AS
WITH base AS (
  SELECT
    r.credited_amount_inr,
    fc.redeemed_at,
    fc.expires_at,
    -- Bucket the credit into one of three mutually-exclusive states.
    -- This is the same derivation the customer-side ReferralCard does
    -- in JS; centralising it here keeps operator-side tiles aligned
    -- with what the customer sees on their own card.
    CASE
      WHEN fc.redeemed_at IS NOT NULL                            THEN 'redeemed'
      WHEN fc.expires_at  < now() AND fc.redeemed_at IS NULL     THEN 'expired'
      ELSE                                                            'pending'
    END AS state
  FROM referrals r
  JOIN fleet_credits fc ON fc.id = r.fleet_credit_id
)
SELECT
  COUNT(*)                                                          AS total_referrals,
  COALESCE(SUM(credited_amount_inr), 0)::NUMERIC(12,2)              AS granted_inr,

  COUNT(*) FILTER (WHERE state = 'redeemed')                        AS redeemed_count,
  COALESCE(SUM(credited_amount_inr) FILTER (WHERE state = 'redeemed'), 0)::NUMERIC(12,2) AS redeemed_inr,

  COUNT(*) FILTER (WHERE state = 'expired')                         AS expired_count,
  COALESCE(SUM(credited_amount_inr) FILTER (WHERE state = 'expired'), 0)::NUMERIC(12,2)  AS expired_inr,

  COUNT(*) FILTER (WHERE state = 'pending')                         AS pending_count,
  COALESCE(SUM(credited_amount_inr) FILTER (WHERE state = 'pending'), 0)::NUMERIC(12,2)  AS pending_inr,

  -- Redemption % is INR-weighted (not count-weighted) — same convention
  -- the cashback ROI view uses. A single program will sometimes have a
  -- mix of credit amounts (manual grants, future seasonal promos) and
  -- INR-weighted is the more honest "% of the money we promised that
  -- actually changed hands."
  CASE
    WHEN COALESCE(SUM(credited_amount_inr), 0) > 0
      THEN ROUND(
        100.0 * COALESCE(SUM(credited_amount_inr) FILTER (WHERE state = 'redeemed'), 0)
        / SUM(credited_amount_inr),
        2
      )
    ELSE 0
  END::NUMERIC(5,2)                                                 AS redemption_pct
FROM base;

COMMENT ON VIEW analytics_referral_program_roi IS
  'Phase 4.8. Single-row aggregate: total referrals, granted / redeemed / '
  'expired / pending INR + counts. redemption_pct is INR-weighted to match '
  'the existing cashback ROI convention.';


-- ── 2. Top referrers (limit 20) ────────────────────────────────────────────
CREATE OR REPLACE VIEW analytics_top_referrers AS
SELECT
  r.referrer_fleet_id                                                AS fleet_id,
  f.name                                                             AS fleet_name,
  COUNT(*)::INT                                                      AS referral_count,
  COALESCE(SUM(r.credited_amount_inr), 0)::NUMERIC(10,2)             AS total_credited_inr,
  COUNT(*) FILTER (WHERE fc.redeemed_at IS NOT NULL)::INT            AS redeemed_count,
  COUNT(*) FILTER (
    WHERE fc.expires_at < now() AND fc.redeemed_at IS NULL
  )::INT                                                             AS expired_count,
  -- Most recent referral for this fleet — useful for the dashboard's
  -- "is this referrer still active or did they refer once 6 months ago"
  -- read.
  MAX(r.created_at)                                                  AS last_referral_at
FROM referrals r
JOIN fleets f       ON f.id  = r.referrer_fleet_id
JOIN fleet_credits fc ON fc.id = r.fleet_credit_id
GROUP BY r.referrer_fleet_id, f.name
ORDER BY referral_count DESC, total_credited_inr DESC
LIMIT 20;

COMMENT ON VIEW analytics_top_referrers IS
  'Phase 4.8. Top 20 referrers by count. Includes redeemed/expired '
  'splits per referrer so ops can spot a referrer whose credits all '
  'expired unused (UX signal: they don''t renew often enough).';

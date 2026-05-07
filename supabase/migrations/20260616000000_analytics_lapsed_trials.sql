-- ════════════════════════════════════════════════════════════════════════════
-- Migration: analytics_lapsed_trials (Phase 3.11)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Re-engagement surface for ops. A "lapsed trial" is a fleet that finished
-- their free trial without ever converting to a paid plan. The combination
-- the view looks for is:
--
--     subscriptions.status               = 'expired'
--     subscriptions.current_period_start IS NULL
--
-- The first condition is the cron-driven post-trial state (set by the
-- grace-period trigger from 20260504); the second confirms the customer
-- never had a paid billing period at any point. A subscription that
-- converted, ran for a while, then later expired (e.g. card died, never
-- recovered) is NOT a lapsed trial — those land in the failed-payment /
-- dunning view from Phase 3.9 instead.
--
-- Window: trials that lapsed in the last 30 days. Older lapses are too
-- cold for ops outreach to be effective; if we ever want a longer
-- horizon for cohort analysis it should be a separate view, not this one.
--
-- Plain view (no MV): subscriptions is small at our scale, the WHERE is
-- index-friendly, and there's no point materializing a view that's
-- specifically scoped to recent activity (the freshness gap from a
-- nightly REFRESH would defeat the purpose).
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
--   - 20260501000000_subscription_system_v2.sql          (subscriptions)
--   - 20260504000000_grace_period_trigger.sql            (status='expired')
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW analytics_lapsed_trials AS
SELECT
  s.fleet_id,
  f.name                                                    AS fleet_name,
  f.manager_id,
  s.plan                                                    AS trial_plan,
  s.created_at                                              AS signed_up_at,
  s.trial_ends_at                                           AS trial_ended_at,
  s.grace_period_end                                        AS grace_period_end,
  -- Days since trial ended. We compute server-side so the dashboard sort
  -- order is canonical and the CSV export carries a useful column without
  -- a client-side date library. EXTRACT(EPOCH …) / 86400 gives total days
  -- across month boundaries — `EXTRACT(DAY FROM interval)` would only
  -- pull the day component out of an already-decomposed interval and
  -- under-report once the interval rolls over a month.
  FLOOR(GREATEST(0, EXTRACT(EPOCH FROM (now() - s.trial_ends_at)) / 86400))::INT
    AS days_since_lapsed,
  -- Did the customer engage at all during the trial? We surface a binary
  -- "added vehicles" flag so ops can prioritise — a lapsed trial that
  -- registered 12 vehicles is worth a phone call, one that never even
  -- logged in twice probably isn't. Counting from `vehicles` keeps this
  -- O(N) on a tiny table; if it gets hot, denormalize onto fleets.
  EXISTS (
    SELECT 1 FROM vehicles v WHERE v.fleet_id = s.fleet_id LIMIT 1
  )                                                         AS added_vehicles,
  -- Did they ever extend their trial (either via the operator extend-trial
  -- action or the self-serve flow)? If yes, they were genuinely
  -- considering us — those are the warmest re-engagement candidates.
  COALESCE(s.trial_self_extended_at IS NOT NULL, false)
    OR EXISTS (
      SELECT 1 FROM audit_logs al
      WHERE al.fleet_id = s.fleet_id
        AND al.action   = 'extend-trial'
    )                                                       AS trial_was_extended
FROM subscriptions s
JOIN fleets        f ON f.id = s.fleet_id
WHERE s.status               = 'expired'
  AND s.current_period_start IS NULL
  AND s.trial_ends_at       >= (now() - INTERVAL '30 days')
ORDER BY s.trial_ends_at DESC;

COMMENT ON VIEW analytics_lapsed_trials IS
  'Phase 3.11. Fleets whose free trial expired in the last 30 days '
  'without ever converting (current_period_start IS NULL). Includes '
  'engagement signals (added_vehicles, trial_was_extended) so ops can '
  'prioritise outreach. Plain view — small table, recency-scoped.';

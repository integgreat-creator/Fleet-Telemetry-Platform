-- ════════════════════════════════════════════════════════════════════════════
-- Migration: subscriptions.trial_self_extended_at (Phase 3.5)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Tracks whether a fleet has used their one-time self-serve trial
-- extension. Nullable timestamp:
--   NULL          → not yet used; "Need more time?" link is offered
--   ISO timestamp → already used; link is hidden
--
-- The cap is enforced by the extend-trial-self-serve edge function
-- checking IS NULL before applying. We don't model "max extensions" as a
-- counter — the once-per-fleet rule is the simplest enforceable policy
-- and changing to a different cap later is a constraint check, not a
-- schema migration.
--
-- Distinct from the existing admin-api `extend-trial` action: that's
-- operator-only (admin-secret gated), no cap, no reason capture, used
-- when ops decides to grant time manually. Self-serve writes its own
-- audit-log action (`trial.self_extended`) so the two paths are
-- distinguishable in the timeline.
--
-- Depends on:
--   - 20260501000000_subscription_system_v2.sql (subscriptions table)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS trial_self_extended_at TIMESTAMPTZ;

COMMENT ON COLUMN subscriptions.trial_self_extended_at IS
  'Timestamp when the customer used their one-time self-serve trial '
  'extension (Phase 3.5). NULL = not yet used. Operator extensions via '
  'admin-api`s extend-trial action don''t touch this column — they''re '
  'unlimited and tracked only via audit_logs.';

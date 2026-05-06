-- ════════════════════════════════════════════════════════════════════════════
-- Migration: subscriptions.status += 'paused' (Phase 3.4)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Razorpay supports pausing a subscription at cycle end (the customer keeps
-- access through the current paid period, then billing stops without
-- cancelling). Customers can resume any time. We mirror Razorpay's state
-- with a new `paused` value on `subscriptions.status`.
--
-- Distinct from existing states:
--   - `active`    : currently being billed
--   - `inactive`  : cancelled / never paid
--   - `suspended` : payment failed (one-shot, customer fixes card to recover)
--   - `paused`    : NEW. Customer-initiated pause. Razorpay isn't billing,
--                   no payment failure, customer can resume.
--   - `trial`     : pre-payment
--   - `expired`   : trial / sub expired beyond grace
--
-- The webhook handler in razorpay-webhook will catch `subscription.paused`
-- and `subscription.resumed` events to flip status. The trigger from
-- 20260501 (vehicle limit / driver limit checks) treats only `active` as
-- the green-light state, so a paused subscription correctly blocks new
-- vehicles / drivers — which is what we want for a pause that's saving
-- the customer money.
--
-- Depends on:
--   - 20260501000000_subscription_system_v2.sql (the original status CHECK)
-- ════════════════════════════════════════════════════════════════════════════

-- Idempotent: drop the constraint by name (matches the original migration's
-- naming) before re-creating with the expanded set.
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active', 'inactive', 'suspended', 'trial', 'expired', 'paused'));

COMMENT ON COLUMN subscriptions.status IS
  'Subscription state machine. paused = customer-initiated pause via '
  'razorpay-pause-subscription; resumes by calling razorpay-resume-subscription. '
  'Distinct from suspended (payment failure) and inactive (cancelled).';

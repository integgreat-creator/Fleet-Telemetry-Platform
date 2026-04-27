-- ════════════════════════════════════════════════════════════════════════════
-- Migration: subscriptions.razorpay_subscription_short_url (Phase 1.6.3)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Razorpay returns a `short_url` field on every subscription it creates —
-- a hosted page where the customer can update card-on-file, view billing
-- history, and cancel without leaving the Razorpay UI.
--
-- We store this so the renewal-reminder banner's CTA can deep-link to the
-- right page instead of dumping the customer back at the AdminPage and
-- expecting them to figure out what to do next.
--
-- Captured on TWO webhook events:
--   1. razorpay-create-subscription's response (POST /v1/subscriptions)
--   2. razorpay-webhook subscription.activated / subscription.charged
--      (in case the URL ever gets regenerated; defensive)
--
-- Dormant-mode safe: column is nullable and stays null until a real
-- Razorpay subscription is created. Banner CTA falls back to AdminPage
-- navigation when null.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS razorpay_subscription_short_url TEXT;

COMMENT ON COLUMN subscriptions.razorpay_subscription_short_url IS
  'Razorpay-hosted page URL where the customer can update card-on-file '
  'and manage their subscription. Populated by razorpay-create-subscription '
  'and refreshed by razorpay-webhook on activation/charge events. Used by '
  'the renewal-reminder banner CTA in Phase 1.6.2.';

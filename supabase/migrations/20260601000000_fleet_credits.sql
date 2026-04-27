-- ════════════════════════════════════════════════════════════════════════════
-- Migration: fleet_credits — cashback / promo credit ledger (Phase 1.6.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Stores per-fleet credit grants (currently just first-charge cashback) and
-- their redemption state. The webhook flow:
--
--   1. First `subscription.charged` for a fleet → INSERT credit row
--      (reason='first_charge_cashback'). Unique partial index prevents
--      double-granting.
--   2. Subsequent `subscription.charged` → look for unredeemed unexpired
--      credit rows → call Razorpay refund API for each → UPDATE credit row
--      with redemption_refund_id + redeemed_at.
--
-- Dormant-mode safe: schema exists from day one, but nothing fires until
-- razorpay-webhook starts receiving real events. Refund logic is also
-- a no-op while RAZORPAY_KEY_ID is unset.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets table)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. fleet_credits table ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fleet_credits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id                 uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,

  -- ── Grant ─────────────────────────────────────────────────────────────────
  amount_inr               NUMERIC(10,2) NOT NULL CHECK (amount_inr > 0),
  reason                   TEXT NOT NULL,            -- 'first_charge_cashback', 'manual_grant', 'promo_<id>', …
  granted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL,
  source_payment_id        TEXT,                     -- Razorpay payment_id that triggered the grant (if applicable)

  -- ── Redemption (set when applied against a future charge) ────────────────
  redeemed_at              TIMESTAMPTZ,
  redemption_payment_id    TEXT,                     -- Razorpay payment_id this credit was applied against
  redemption_refund_id     TEXT,                     -- Razorpay refund_id from the partial refund

  notes                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Redemption fields are all-or-nothing — either the credit is unredeemed
  -- (all three null) or fully redeemed (all three set).
  CONSTRAINT fleet_credits_redemption_consistent CHECK (
    (redeemed_at IS NULL AND redemption_payment_id IS NULL AND redemption_refund_id IS NULL)
    OR
    (redeemed_at IS NOT NULL AND redemption_payment_id IS NOT NULL AND redemption_refund_id IS NOT NULL)
  ),
  -- Expired credits can't be redeemed retroactively. Either the redemption
  -- timestamp is unset, or it falls before the expiry.
  CONSTRAINT fleet_credits_redeem_before_expiry CHECK (
    redeemed_at IS NULL OR redeemed_at <= expires_at
  )
);

CREATE INDEX IF NOT EXISTS fleet_credits_fleet_id_idx
  ON fleet_credits (fleet_id);

-- Hot path: "find unredeemed, unexpired credits for this fleet, oldest
-- first". The webhook walks this list on every renewal charge.
CREATE INDEX IF NOT EXISTS fleet_credits_unredeemed_idx
  ON fleet_credits (fleet_id, expires_at)
  WHERE redeemed_at IS NULL;

-- One first-charge cashback per fleet. Drop and use `reason` alone if we
-- ever support multiple cashback grants per fleet (e.g. seasonal promos).
CREATE UNIQUE INDEX IF NOT EXISTS fleet_credits_first_charge_unique
  ON fleet_credits (fleet_id)
  WHERE reason = 'first_charge_cashback';

COMMENT ON TABLE fleet_credits IS
  'Per-fleet credit grants (cashback, promos) and their redemption state. '
  'Issued by razorpay-webhook on subscription.charged events; redeemed via '
  'Razorpay partial refunds on subsequent charges.';
COMMENT ON COLUMN fleet_credits.reason IS
  'Free-text grant reason. Convention: '
  '''first_charge_cashback'' for the 10%-cap-₹500 first-paid-charge bonus, '
  '''manual_grant'' for ops grants, '
  '''promo_<id>'' for campaign-driven grants.';


-- ── 2. RLS — fleet managers can read their own credits, never write ────────
-- All writes go through the service role inside the webhook.

ALTER TABLE fleet_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read own fleet credits" ON fleet_credits;
CREATE POLICY "managers read own fleet credits" ON fleet_credits
  FOR SELECT
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );

-- ════════════════════════════════════════════════════════════════════════════
-- Migration: referrals table (Phase 4.6)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Tracks referral attributions and the credits issued for them. One row
-- is created when a referred fleet's FIRST paid charge lands (the trigger
-- that "the referral converted") — at the same moment a fleet_credit
-- row is granted to the referrer.
--
-- Lifecycle is implicit:
--   - presence of a row     ⇒ referral was credited
--   - absence of a row      ⇒ either the fleet wasn't referred, or
--                              the referred fleet hasn't converted yet
-- The downstream credit lifecycle (redeemed / expired) lives on
-- `fleet_credits` — we point at it via fleet_credit_id so a join answers
-- "did this referral pay off."
--
-- Idempotency:
--   - UNIQUE (referred_fleet_id) — one referral per referred fleet. A
--     webhook redelivery hits 23505 and the handler treats that as a
--     no-op, mirroring the first-charge cashback pattern.
--   - The fleet_credits row carries a UNIQUE partial index on (fleet_id)
--     WHERE reason='referral_credit', so even if the referrals INSERT
--     somehow succeeded twice (it can't, given the constraint above) the
--     credit grant would still be deduped.
--
-- Constants set in razorpay-webhook (see REFERRAL_* there):
--   ₹500 flat credit per successful referral
--   90-day expiry (mirrors first-charge cashback)
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets)
--   - 20260601000000_fleet_credits.sql                   (fleet_credits)
--   - 20260617000000_fleet_acquisition_source.sql        (referrer column)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS referrals (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The customer who shared the link. ON DELETE CASCADE: if their fleet
  -- gets nuked, the referral history goes too — there's no orphan
  -- "referrals from a deleted fleet" state worth keeping.
  referrer_fleet_id    UUID NOT NULL
    REFERENCES fleets(id) ON DELETE CASCADE,
  -- The newly-converted customer. CASCADE for the same reason — the
  -- attribution is meaningless if the referred fleet is gone.
  referred_fleet_id    UUID NOT NULL
    REFERENCES fleets(id) ON DELETE CASCADE,
  -- The credit row issued to the referrer. RESTRICT (not CASCADE)
  -- because deleting the credit row on its own would leave the referral
  -- pointing into space — if you really want to remove a credit, you
  -- delete the referral first.
  fleet_credit_id      UUID NOT NULL
    REFERENCES fleet_credits(id) ON DELETE RESTRICT,
  credited_amount_inr  NUMERIC(10,2) NOT NULL CHECK (credited_amount_inr > 0),
  -- Razorpay payment that triggered the credit. Forensic — useful for
  -- "the customer disputes the credit, when did they pay?" queries.
  payment_id           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One referral per referred fleet — provides idempotency on webhook
  -- redelivery. Any second insert hits 23505 and the writer no-ops.
  UNIQUE (referred_fleet_id),

  -- Self-referral guard: a customer can't refer their own fleet. The
  -- application layer already blocks this (the share link is per-fleet
  -- and signup wires through a different fleet's referrer_fleet_id),
  -- but enforcing at the DB stops a malicious / buggy writer.
  CHECK (referrer_fleet_id <> referred_fleet_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_fleet
  ON referrals(referrer_fleet_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_fleet
  ON referrals(referred_fleet_id);
CREATE INDEX IF NOT EXISTS idx_referrals_credit
  ON referrals(fleet_credit_id);

-- ── Belt-and-braces idempotency on the credit grant ─────────────────────────
-- The referrals UNIQUE on referred_fleet_id catches the most common
-- redelivery case, but the webhook's flow does an exists-check then two
-- inserts — there's a tiny race where two concurrent webhooks pass the
-- check and both grant credits before either lands the referrals row.
-- This partial unique index makes the second credit INSERT 23505 and
-- the writer's manual-rollback path takes over cleanly. Only the
-- referral-credit reason is constrained — other credit reasons (manual
-- grants, future promo codes, etc.) deliberately have no per-payment
-- uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fleet_credits_referral_per_payment
  ON fleet_credits(fleet_id, source_payment_id)
  WHERE reason = 'referral_credit' AND source_payment_id IS NOT NULL;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Customers see referrals where THEIR fleet is the referrer (so the
-- customer-facing "my referrals" list works). They do NOT see rows where
-- they're the referred fleet — that information would let one customer
-- learn that another customer referred them, which leaks identity.
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "referrals_select_own_referrer" ON referrals;
CREATE POLICY "referrals_select_own_referrer"
  ON referrals
  FOR SELECT
  USING (
    referrer_fleet_id IN (
      SELECT id FROM fleets WHERE manager_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies — referrals are written exclusively
-- by the razorpay-webhook (service role), never by customer-side code.
-- Operator-side writes (if any future ops tool needs them) should also
-- use the service role.

COMMENT ON TABLE referrals IS
  'Phase 4.6. One row per successfully-credited referral. Created by '
  'the razorpay-webhook on a referred fleet''s first paid charge, at '
  'the same time a fleet_credits row is issued to the referrer. RLS '
  'lets the referrer see their own attributions; the referred fleet '
  'cannot see who referred them.';

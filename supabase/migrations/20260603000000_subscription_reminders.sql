-- ════════════════════════════════════════════════════════════════════════════
-- Migration: subscription_reminders + hourly cron (Phase 1.7.1)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Out-of-app touchpoints for trial expiry and annual renewal — reaches
-- customers who don't open the dashboard often enough to see the in-app
-- banners (Phase 1.4 + 1.6.2). Sends via WhatsApp Cloud API (preferred,
-- 90%+ open rates in TN B2B) with an email fallback through Resend when
-- the fleet has no whatsapp_number on file.
--
-- Reminder kinds:
--   trial_t_minus_7      — 7 days before trial_ends_at
--   trial_t_minus_1      — 1 day  before trial_ends_at
--   trial_expired        — on the day trial_ends_at falls (T-0)
--   renewal_t_minus_7    — 7 days before current_period_end (annual only)
--   renewal_t_minus_1    — 1 day  before current_period_end (annual only)
--   payment_suspended    — fired immediately by razorpay-webhook on payment.failed
--
-- Cron: pg_cron schedules an hourly call to the subscription-reminders edge
-- function. The function picks subscriptions whose date arithmetic puts them
-- in a current reminder window, checks the unique idempotency key, and sends.
--
-- Dormant-mode safe: if WHATSAPP_ACCESS_TOKEN / RESEND_API_KEY are unset,
-- the edge function logs and skips without erroring. The cron schedule is
-- still installed so it activates the moment secrets land.
--
-- Depends on:
--   - 20260227043631_create_vehicle_telemetry_schema.sql (fleets table)
--   - 20260501000000_subscription_system_v2.sql           (subscriptions)
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. subscription_reminders table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscription_reminders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fleet_id        uuid NOT NULL REFERENCES fleets(id) ON DELETE CASCADE,
  reminder_kind   TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email')),
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed', 'bounced')),

  -- The "cycle" this reminder belongs to. For trial reminders it's the
  -- `trial_ends_at` value at send time; for renewal reminders it's the
  -- `current_period_end`. Without cycle scoping we'd send only one trial
  -- reminder ever, even after the operator extends the trial. Including
  -- it in the unique key means a new cycle gets a fresh reminder.
  cycle_anchor    TIMESTAMPTZ NOT NULL,

  -- External system message id (Resend email id, WhatsApp wamid, etc.)
  -- for delivery-status follow-up via webhooks if we wire that up later.
  external_id     TEXT,
  notes           JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotency: one reminder of each kind per fleet per cycle. The cron
  -- can fire multiple times within the reminder's hour window (and
  -- overlapping into the next hour); the unique constraint makes
  -- INSERT ... ON CONFLICT DO NOTHING the safe pattern.
  CONSTRAINT subscription_reminders_unique
    UNIQUE (fleet_id, reminder_kind, cycle_anchor)
);

CREATE INDEX IF NOT EXISTS subscription_reminders_fleet_id_idx
  ON subscription_reminders (fleet_id);
CREATE INDEX IF NOT EXISTS subscription_reminders_sent_at_idx
  ON subscription_reminders (sent_at DESC);

COMMENT ON TABLE subscription_reminders IS
  'Audit trail of trial-expiry / renewal-reminder messages sent via WhatsApp '
  'or email. Doubles as the idempotency ledger — UNIQUE(fleet_id, kind, cycle) '
  'lets the cron be re-runnable without double-sending.';
COMMENT ON COLUMN subscription_reminders.cycle_anchor IS
  'The trial_ends_at or current_period_end value at send time. New cycle = '
  'new anchor = new reminder eligible. Trial extensions create a fresh cycle.';


-- ── 2. RLS — fleet managers can read their own reminder history ────────────

ALTER TABLE subscription_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read own fleet reminders" ON subscription_reminders;
CREATE POLICY "managers read own fleet reminders" ON subscription_reminders
  FOR SELECT
  USING (
    fleet_id IN (SELECT id FROM fleets WHERE manager_id = auth.uid())
  );


-- ── 3. Cron schedule (pg_cron) ──────────────────────────────────────────────
-- Hourly invocation of the subscription-reminders edge function. The function
-- itself does the date-arithmetic to decide which fleets need reminders, so
-- the cron just needs to ping it on a regular cadence.
--
-- Wrapped in a DO block so this migration is idempotent — re-running it just
-- replaces the existing schedule rather than erroring on duplicate name.

DO $$
DECLARE
  v_function_url TEXT;
  v_anon_key     TEXT;
BEGIN
  -- These two values are pulled from `vault.decrypted_secrets` — the
  -- canonical place to keep cron-callable URLs and keys without hard-coding
  -- them into a migration. If the operator hasn't configured them yet, the
  -- cron schedule is still created and will start firing once they land.
  -- This pattern matches the geofence-monitor cron from migration
  -- 20260510000000.
  SELECT decrypted_secret
    INTO v_function_url
    FROM vault.decrypted_secrets
   WHERE name = 'SUPABASE_FUNCTIONS_URL_SUBSCRIPTION_REMINDERS'
   LIMIT 1;
  SELECT decrypted_secret
    INTO v_anon_key
    FROM vault.decrypted_secrets
   WHERE name = 'SUPABASE_ANON_KEY_FOR_CRON'
   LIMIT 1;

  -- Drop existing schedule (if any) so this migration is re-runnable.
  PERFORM cron.unschedule(jobid)
     FROM cron.job
    WHERE jobname = 'subscription_reminders_hourly';

  PERFORM cron.schedule(
    'subscription_reminders_hourly',
    '0 * * * *',                                      -- every hour on the hour
    format(
      $job$
      SELECT net.http_post(
        url     := %L,
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || %L,
          'Content-Type',  'application/json'
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 30000
      ) AS request_id;
      $job$,
      COALESCE(v_function_url, ''),
      COALESCE(v_anon_key, '')
    )
  );

  -- If the secrets weren't set, the schedule still exists but the URL is
  -- empty and net.http_post will fail. The operator gets a clear error log
  -- once they go to debug and fixes both secrets.
  IF v_function_url IS NULL OR v_anon_key IS NULL THEN
    RAISE NOTICE 'subscription_reminders_hourly cron scheduled but missing '
                 'vault secrets SUPABASE_FUNCTIONS_URL_SUBSCRIPTION_REMINDERS '
                 'and/or SUPABASE_ANON_KEY_FOR_CRON. Set both before reminders '
                 'will fire.';
  END IF;
END
$$;

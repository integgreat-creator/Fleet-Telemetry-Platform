/**
 * razorpay-cancel-subscription edge function
 *
 * Self-serve subscription cancellation for the customer's own fleet. Phase 3.2.
 *
 * Auth: Supabase JWT. Fleet resolved via `fleets.manager_id` — the cancel
 * is implicitly scoped to the caller's fleet, no fleet_id parameter
 * accepted from the client.
 *
 * Request:
 *   POST { reason: string, comment?: string }
 *     reason   — one of an enum the client renders (see RECOGNISED_REASONS).
 *                Free-form fallback ('other') is accepted; everything outside
 *                the enum is normalized to 'other' to keep ops dashboards
 *                aggregable.
 *     comment  — optional free-text. Capped at 500 chars to bound storage.
 *
 * Response (200):
 *   { ok: true, cancel_at_cycle_end: true,
 *     razorpay_subscription_id, current_period_end }
 *
 * Failure modes:
 *   401 — missing / invalid JWT
 *   403 — caller has no fleet
 *   404 — fleet has no active Razorpay subscription
 *   400 — fleet's subscription isn't currently active (already cancelled,
 *         in trial, suspended, expired)
 *   503 — Razorpay credentials not configured (dormant mode)
 *   502 — Razorpay API rejected the request
 *
 * Cancellation flow:
 *   1. We call Razorpay's POST /v1/subscriptions/<id>/cancel?cancel_at_cycle_end=1.
 *      The customer keeps access through their current paid period; status
 *      stays 'active' on our side until Razorpay's subscription.cancelled
 *      webhook lands at cycle end, which the existing handler in
 *      razorpay-webhook flips to 'inactive'.
 *   2. We log the reason + comment to audit_logs immediately so ops has the
 *      churn signal even before the cycle ends.
 *
 * Environment:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   — Razorpay API credentials
 *   SUPABASE_URL, SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY              — standard wiring
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RZP_KEY_ID       = Deno.env.get('RAZORPAY_KEY_ID')     ?? '';
const RZP_KEY_SECRET   = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';

/// Reasons the dashboard renders. Anything else lands as 'other' so the
/// audit-log aggregations don't end up with an open enum that grows on
/// every typo. Add new values here AND in the i18n dropdown to keep the
/// two in sync.
const RECOGNISED_REASONS: ReadonlySet<string> = new Set([
  'too_expensive',
  'missing_features',
  'switching_competitor',
  'temporary_pause',
  'just_exploring',
  'other',
]);

const COMMENT_MAX_CHARS = 500;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: message, ...extra }, status);
}

// ─── Razorpay API ────────────────────────────────────────────────────────────

async function cancelRazorpaySubscription(opts: {
  subscriptionId:    string;
  cancelAtCycleEnd:  boolean;
}): Promise<{ id: string; status: string; current_end?: number }> {
  const auth = btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`);
  const url  = `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(opts.subscriptionId)}/cancel`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      // 1 = cancel at end of current paid cycle. 0 would terminate
      // immediately and prorate — we don't want to refund a partial month
      // and the customer paid for service through the cycle anyway.
      cancel_at_cycle_end: opts.cancelAtCycleEnd ? 1 : 0,
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Razorpay cancel failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  return await res.json();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return err('Method not allowed', 405);

  // Surface Razorpay-not-configured FIRST so the modal can show a friendly
  // "online cancellation isn't available; contact support" message without
  // a JWT round-trip. Same dormant-mode pattern as razorpay-create-subscription.
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    return err(
      'Razorpay not configured',
      503,
      {
        detail:
          'Online cancellation is not yet enabled. Please contact support ' +
          'to cancel your subscription.',
      },
    );
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return err('Missing Authorization header', 401);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return err('Unauthorized', 401);

  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Resolve fleet ─────────────────────────────────────────────────────────
  const { data: fleet, error: fleetErr } = await adminClient
    .from('fleets')
    .select('id')
    .eq('manager_id', user.id)
    .single();
  if (fleetErr || !fleet) return err('No fleet found for this account', 403);

  // ── Parse + validate body ─────────────────────────────────────────────────
  let body: { reason?: string; comment?: string };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const rawReason  = String(body.reason ?? '').trim();
  // Normalize to the recognised enum or fall through to 'other'. Keeps the
  // audit-log aggregations clean even if the client sends a typo.
  const reason     = RECOGNISED_REASONS.has(rawReason) ? rawReason : 'other';
  const comment    = (typeof body.comment === 'string' ? body.comment : '')
                      .trim()
                      .slice(0, COMMENT_MAX_CHARS);

  // ── Look up the active subscription ───────────────────────────────────────
  const { data: sub, error: subErr } = await adminClient
    .from('subscriptions')
    .select('razorpay_subscription_id, status, current_period_end')
    .eq('fleet_id', fleet.id)
    .single();
  if (subErr || !sub) return err('No subscription found for this fleet', 404);

  if (!sub.razorpay_subscription_id) {
    return err('No active Razorpay subscription to cancel', 404);
  }
  // Allow cancel from active OR paused — a customer who paused and
  // decided to leave shouldn't have to resume just to cancel.
  // Phase 3.4 added paused; everything else (trial / expired / inactive
  // / suspended) is rejected.
  if (sub.status !== 'active' && sub.status !== 'paused') {
    return err(
      `Cannot cancel a ${sub.status} subscription`,
      400,
      { current_status: sub.status },
    );
  }

  // ── Cancel via Razorpay (cycle-end) ───────────────────────────────────────
  let rzpResult: { id: string; status: string; current_end?: number };
  try {
    rzpResult = await cancelRazorpaySubscription({
      subscriptionId:   sub.razorpay_subscription_id as string,
      cancelAtCycleEnd: true,
    });
  } catch (e) {
    return err((e as Error).message, 502);
  }

  // ── Audit trail ───────────────────────────────────────────────────────────
  // We DON'T flip subscriptions.status here. The webhook fires
  // `subscription.cancelled` at cycle end and the existing handler sets
  // 'inactive'. Until then the customer keeps paid access — that's what
  // they paid for, and breaking it early would invite refund disputes.
  await adminClient.from('audit_logs').insert({
    fleet_id:      fleet.id,
    user_id:       user.id,
    action:        'subscription.cancellation_requested',
    resource_type: 'subscription',
    resource_id:   null,
    new_values: {
      reason,
      // Stash the raw client value too so the operator can spot a
      // misspelling that landed in the 'other' bucket without losing the
      // signal.
      reason_raw:           rawReason,
      comment:              comment || null,
      cancel_at_cycle_end:  true,
      razorpay_status:      rzpResult.status,
    },
  });

  return json({
    ok:                       true,
    cancel_at_cycle_end:      true,
    razorpay_subscription_id: rzpResult.id,
    razorpay_status:          rzpResult.status,
    current_period_end:       sub.current_period_end,
  });
});

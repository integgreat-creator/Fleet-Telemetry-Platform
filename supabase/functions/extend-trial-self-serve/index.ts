/**
 * extend-trial-self-serve edge function
 *
 * Customer-facing one-time trial extension. Phase 3.5.
 *
 * Distinct from admin-api `extend-trial`:
 *   - admin-api/extend-trial: operator-only (admin-secret gated). No cap.
 *     Used when ops manually grants time outside the policy.
 *   - this:                  customer-only (JWT). Capped at 7 days,
 *                            once per fleet, requires a reason.
 *
 * Both paths converge on `subscriptions.trial_ends_at`. Only this one
 * sets `trial_self_extended_at` so we can prevent re-use.
 *
 * Auth: Supabase JWT. Fleet resolved via fleets.manager_id.
 *
 * Request:
 *   POST { days: number (1-7), reason: string, comment?: string }
 *
 * Response (200):
 *   { ok: true, trial_ends_at: ISO, days_added: number }
 *
 * Failure modes:
 *   401 — missing / invalid JWT
 *   403 — caller has no fleet
 *   404 — no subscription
 *   400 — not on trial / already self-extended / days out of range
 *   400 — invalid reason (whitelist mismatch)
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MIN_DAYS         = 1;
const MAX_DAYS         = 7;
const COMMENT_MAX      = 500;

/// Mirrors the dropdown values in the dashboard's TrialExtensionModal.
/// Anything outside this set lands in the 'other' bucket so audit-log
/// aggregations stay clean. Raw value is preserved as `reason_raw` for
/// forensics, same pattern as cancel.
const RECOGNISED_REASONS: ReadonlySet<string> = new Set([
  'still_evaluating',
  'waiting_on_team_decision',
  'havent_set_up_yet',
  'need_more_time_to_test',
  'other',
]);

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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return err('Method not allowed', 405);

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
  let body: { days?: number; reason?: string; comment?: string };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const days = Number(body.days);
  if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
    return err(`days must be an integer between ${MIN_DAYS} and ${MAX_DAYS}`, 400);
  }

  const rawReason = String(body.reason ?? '').trim();
  const reason    = RECOGNISED_REASONS.has(rawReason) ? rawReason : 'other';
  const comment   = (typeof body.comment === 'string' ? body.comment : '')
                    .trim()
                    .slice(0, COMMENT_MAX);

  // ── Check current subscription state ──────────────────────────────────────
  const { data: sub, error: subErr } = await adminClient
    .from('subscriptions')
    .select('id, status, trial_ends_at, trial_self_extended_at')
    .eq('fleet_id', fleet.id)
    .single();
  if (subErr || !sub) return err('Subscription not found for this fleet', 404);

  if (sub.status !== 'trial') {
    return err(
      `Cannot extend trial — subscription is ${sub.status}`,
      400,
      { current_status: sub.status },
    );
  }

  if (sub.trial_self_extended_at) {
    return err(
      'Trial extension already used',
      400,
      { previously_extended_at: sub.trial_self_extended_at },
    );
  }

  // ── Compute new trial_ends_at ─────────────────────────────────────────────
  // Add `days` to the LATER of (current trial_ends_at, now). If trial
  // already lapsed (rare — webhook would normally have flipped status to
  // 'expired') we extend from now so the customer gets the full grant.
  const nowMs    = Date.now();
  const baseMs   = sub.trial_ends_at
    ? Math.max(new Date(sub.trial_ends_at as string).getTime(), nowMs)
    : nowMs;
  const newEndAt = new Date(baseMs + days * 86_400_000).toISOString();
  const usedAt   = new Date().toISOString();

  // ── Apply ─────────────────────────────────────────────────────────────────
  const { error: updErr } = await adminClient
    .from('subscriptions')
    .update({
      trial_ends_at:           newEndAt,
      trial_self_extended_at:  usedAt,
      updated_at:              usedAt,
    })
    .eq('id', sub.id)
    // Idempotency guard: if two clicks land in flight, the second one
    // hits the IS NULL filter as already-set and updates nothing.
    .is('trial_self_extended_at', null);
  if (updErr) return err(updErr.message, 500);

  // ── Audit ────────────────────────────────────────────────────────────────
  await adminClient.from('audit_logs').insert({
    fleet_id:      fleet.id,
    user_id:       user.id,
    action:        'trial.self_extended',
    resource_type: 'subscription',
    resource_id:   sub.id,
    old_values: {
      trial_ends_at: sub.trial_ends_at,
    },
    new_values: {
      trial_ends_at:    newEndAt,
      days_added:       days,
      reason,
      reason_raw:       rawReason,
      comment:          comment || null,
    },
  });

  return json({
    ok:            true,
    trial_ends_at: newEndAt,
    days_added:    days,
  });
});

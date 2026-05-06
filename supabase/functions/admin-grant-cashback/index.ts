/**
 * admin-grant-cashback edge function
 *
 * Operator-only manual cashback grant. Phase 3.6.
 *
 * Use case: ops compensates a fleet for a specific incident — failed
 * cards we couldn't recover from automatically, a botched onboarding,
 * promotional makegoods. Without this endpoint they'd be writing INSERTs
 * directly into `fleet_credits`, which (a) bypasses the audit log and
 * (b) is error-prone enough that a typo could blow up the cashback
 * redemption flow.
 *
 * Auth: X-Admin-Secret header (operator-only, same secret as
 * razorpay-provision-plans / analytics-api). No JWT — this is for
 * support staff acting on a customer's behalf.
 *
 * Request:
 *   POST { fleet_id: uuid, amount_inr: number, reason: string,
 *          expires_in_days?: number (default 90),
 *          comment?: string }
 *
 * Response (200):
 *   { ok: true, credit_id: uuid, amount_inr, expires_at }
 *
 * Failure modes:
 *   403 — admin secret missing / wrong
 *   400 — fleet_id missing / not UUID / amount out of range / reason missing
 *   404 — fleet not found
 *
 * Sanity limits:
 *   - amount_inr: 1–10,000 INR. Above 10k a follow-up should go through a
 *     more deliberate process (manager approval, not a curl).
 *   - expires_in_days: 1–365. Default 90 mirrors the first-charge cashback
 *     expiry from razorpay-webhook so customer expectations stay consistent.
 *
 * Reason is free-form (the operator types why), but conventionally
 * starts with `manual_` so the analytics_cashback_roi view can split
 * automated grants (`first_charge_cashback`) from manual ones for
 * reporting later.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET     = Deno.env.get('ADMIN_SECRET') ?? '';

const MIN_INR              = 1;
const MAX_INR              = 10_000;
const MIN_EXPIRY_DAYS      = 1;
const MAX_EXPIRY_DAYS      = 365;
const DEFAULT_EXPIRY_DAYS  = 90;
const COMMENT_MAX          = 500;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-secret',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return err('Method not allowed', 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = req.headers.get('X-Admin-Secret') ?? '';
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return err('Forbidden', 403);
  }

  // ── Parse + validate body ─────────────────────────────────────────────────
  let body: {
    fleet_id?:         string;
    amount_inr?:       number;
    reason?:           string;
    expires_in_days?:  number;
    comment?:          string;
  };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const fleetId = String(body.fleet_id ?? '').trim();
  if (!fleetId)                  return err('fleet_id is required',   400);
  if (!UUID_RE.test(fleetId))    return err('fleet_id must be a UUID', 400);

  const amountInr = Number(body.amount_inr);
  if (!Number.isFinite(amountInr) || amountInr < MIN_INR || amountInr > MAX_INR) {
    return err(`amount_inr must be between ${MIN_INR} and ${MAX_INR}`, 400);
  }

  const reason = String(body.reason ?? '').trim();
  if (!reason)                       return err('reason is required',         400);
  if (reason.length > 64)            return err('reason must be ≤ 64 chars',  400);

  const expiresInDays = body.expires_in_days != null
    ? Number(body.expires_in_days)
    : DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(expiresInDays) ||
      expiresInDays < MIN_EXPIRY_DAYS ||
      expiresInDays > MAX_EXPIRY_DAYS) {
    return err(`expires_in_days must be an integer in [${MIN_EXPIRY_DAYS}, ${MAX_EXPIRY_DAYS}]`, 400);
  }

  const comment = (typeof body.comment === 'string' ? body.comment : '')
                    .trim()
                    .slice(0, COMMENT_MAX);

  // ── Verify fleet exists (clearer error than a foreign-key violation) ─────
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: fleet, error: fleetErr } = await supabase
    .from('fleets')
    .select('id, name')
    .eq('id', fleetId)
    .maybeSingle();
  if (fleetErr) return err(fleetErr.message, 500);
  if (!fleet)   return err('Fleet not found', 404);

  // ── Insert credit row ─────────────────────────────────────────────────────
  // Amount stored as the sanitized number; the unique partial index from
  // 20260601 only fires for `reason = 'first_charge_cashback'` so manual
  // grants can stack arbitrarily on the same fleet (different incidents
  // may warrant separate compensation).
  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
  const { data: credit, error: insErr } = await supabase
    .from('fleet_credits')
    .insert({
      fleet_id:    fleet.id,
      amount_inr:  amountInr,
      reason,
      expires_at:  expiresAt,
      // No source_payment_id — manual grants aren't tied to a Razorpay
      // payment. The notes JSONB carries the comment + grant-source tag
      // so analytics can distinguish ops grants from automated cashback.
      notes: {
        granted_via:  'admin_cashback_grant',
        expires_in_days: expiresInDays,
        ...(comment ? { comment } : {}),
      },
    })
    .select('id')
    .single();
  if (insErr) {
    console.error('[admin-grant-cashback] insert failed', insErr, { fleetId, amountInr });
    return err(insErr.message, 500);
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  // user_id is NULL because admin-secret auth doesn't carry a user. We log
  // the secret-source distinction so an audit reader knows this came from
  // operator intent, not customer self-serve.
  await supabase.from('audit_logs').insert({
    fleet_id:      fleet.id,
    user_id:       null,
    action:        'cashback.manual_granted',
    resource_type: 'fleet_credit',
    resource_id:   credit.id,
    new_values: {
      amount_inr:       amountInr,
      reason,
      expires_at:       expiresAt,
      expires_in_days:  expiresInDays,
      comment:          comment || null,
      granted_via:      'admin_secret',
    },
  });

  console.info('[admin-grant-cashback] granted', {
    fleet_id:    fleet.id,
    fleet_name:  fleet.name,
    credit_id:   credit.id,
    amount_inr:  amountInr,
    reason,
  });

  return json({
    ok:         true,
    credit_id:  credit.id,
    amount_inr: amountInr,
    expires_at: expiresAt,
  });
});

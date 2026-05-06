/**
 * razorpay-pause-subscription edge function
 *
 * Handles BOTH pause and resume — they share auth, fleet scoping,
 * subscription lookup, and audit-log shape; only the Razorpay endpoint and
 * required pre-state differ. Splitting into two files would duplicate
 * ~80 lines of identical boilerplate.
 *
 * Phase 3.4. Self-serve pause is the customer's "I want to keep my data
 * but stop being charged for a month or two" path — distinct from cancel
 * (Phase 3.2, which is at-cycle-end and resumes only via fresh checkout).
 *
 * Request:
 *   POST { action: 'pause' | 'resume' }
 *
 * Auth: Supabase JWT. Fleet resolved via fleets.manager_id; no fleet_id
 * accepted from the client.
 *
 * State preconditions:
 *   - pause:  subscription must be 'active'
 *   - resume: subscription must be 'paused'
 * Anything else → 400 with `current_status` in the body so the modal can
 * render an accurate error.
 *
 * Razorpay endpoints:
 *   - pause:  POST /v1/subscriptions/<id>/pause?pause_at=cycle_end
 *   - resume: POST /v1/subscriptions/<id>/resume?resume_at=now
 *
 * As with cancel, we DON'T flip subscriptions.status here. Razorpay fires
 * subscription.paused / subscription.resumed and the existing handler in
 * razorpay-webhook does the row update. Two reasons:
 *   1. Single writer for the field — no race between this function and the
 *      webhook.
 *   2. Honest UX — the customer keeps paid access until cycle end, so
 *      flipping immediately would lock features they paid for.
 *
 * Dormant-mode safe: 503 with friendly copy when RAZORPAY_KEY_ID is unset.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RZP_KEY_ID       = Deno.env.get('RAZORPAY_KEY_ID')     ?? '';
const RZP_KEY_SECRET   = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';

type Action = 'pause' | 'resume';

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

// ─── Action wiring ──────────────────────────────────────────────────────────
// Per-action config table — keeps the handler body free of branchy ternaries
// and makes it obvious from a glance which action expects which pre-state.

const ACTION_CONFIG: Record<Action, {
  expectedStatus:    string;
  razorpayPath:      string;       // appended to /v1/subscriptions/<id>/...
  razorpayBody:      Record<string, number>;
  auditAction:       string;
}> = {
  pause: {
    expectedStatus: 'active',
    razorpayPath:   'pause',
    razorpayBody:   { pause_at: 0 },          // 0 = pause at cycle end (Razorpay convention)
    auditAction:    'subscription.pause_requested',
  },
  resume: {
    expectedStatus: 'paused',
    razorpayPath:   'resume',
    razorpayBody:   { resume_at: 0 },         // 0 = resume immediately
    auditAction:    'subscription.resume_requested',
  },
};

// ─── Razorpay API ────────────────────────────────────────────────────────────

async function callRazorpay(opts: {
  subscriptionId: string;
  path:           string;
  body:           Record<string, unknown>;
}): Promise<{ id: string; status: string }> {
  const auth = btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`);
  const url  = `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(opts.subscriptionId)}/${opts.path}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(opts.body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Razorpay ${opts.path} failed (${res.status}): ${errBody.slice(0, 300)}`);
  }
  return await res.json();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return err('Method not allowed', 405);

  // Dormant-mode short-circuit before auth, so the UI gets the friendly
  // 503 without a JWT round-trip.
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    return err(
      'Razorpay not configured',
      503,
      {
        detail:
          'Online subscription changes are not yet enabled. ' +
          'Please contact support to pause your subscription.',
      },
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { action?: string };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }
  const action = body.action as Action;
  if (action !== 'pause' && action !== 'resume') {
    return err("action must be 'pause' or 'resume'", 400);
  }
  const cfg = ACTION_CONFIG[action];

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

  // ── Look up subscription ──────────────────────────────────────────────────
  const { data: sub, error: subErr } = await adminClient
    .from('subscriptions')
    .select('razorpay_subscription_id, status')
    .eq('fleet_id', fleet.id)
    .single();
  if (subErr || !sub) return err('No subscription found for this fleet', 404);

  if (!sub.razorpay_subscription_id) {
    return err('No Razorpay subscription to update', 404);
  }
  if (sub.status !== cfg.expectedStatus) {
    return err(
      `Subscription must be ${cfg.expectedStatus} to ${action}`,
      400,
      { current_status: sub.status },
    );
  }

  // ── Razorpay call ─────────────────────────────────────────────────────────
  let rzpResult: { id: string; status: string };
  try {
    rzpResult = await callRazorpay({
      subscriptionId: sub.razorpay_subscription_id as string,
      path:           cfg.razorpayPath,
      body:           cfg.razorpayBody,
    });
  } catch (e) {
    return err((e as Error).message, 502);
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  await adminClient.from('audit_logs').insert({
    fleet_id:      fleet.id,
    user_id:       user.id,
    action:        cfg.auditAction,
    resource_type: 'subscription',
    resource_id:   null,
    new_values: {
      razorpay_status: rzpResult.status,
      // pause_at_cycle_end / resume_immediately stamped here so the
      // history timeline can render the right detail line per row.
      pause_at_cycle_end:  action === 'pause'  ? true : undefined,
      resume_immediate:    action === 'resume' ? true : undefined,
    },
  });

  return json({
    ok:                       true,
    action,
    razorpay_subscription_id: rzpResult.id,
    razorpay_status:          rzpResult.status,
  });
});

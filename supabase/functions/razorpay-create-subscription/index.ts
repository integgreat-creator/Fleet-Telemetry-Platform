/**
 * razorpay-create-subscription edge function
 *
 * Called by the checkout modal when the customer commits. Creates a Razorpay
 * subscription with quantity = vehicle_count, then returns the subscription id
 * + public key so the client can render embedded Razorpay Checkout.
 *
 * Auth: Supabase JWT (Authorization: Bearer <token>). Resolves the caller's
 * fleet via fleets.manager_id; the subscription is implicitly scoped to that
 * fleet — the client cannot create a subscription for someone else.
 *
 * Request:
 *   POST { plan: PlanName, vehicle_count: number, billing_cycle: 'monthly' | 'annual' }
 *
 * Response (200):
 *   { razorpay_subscription_id: string, key_id: string,
 *     amount_paise: number, currency: 'INR' }
 *
 * Failure modes:
 *   401 — missing/invalid JWT
 *   403 — caller has no fleet
 *   404 — plan not found / not active / not per-vehicle
 *   422 — vehicle_count below plan minimum
 *   422 — billing_cycle='annual' but annual not yet unlocked (3-month rule)
 *   503 — Razorpay credentials not configured (dormant mode)
 *   502 — Razorpay API rejected the request
 *
 * The Razorpay subscription notes mirror the keys razorpay-webhook reads, so
 * subscription.activated / subscription.charged events flow through cleanly
 * without further plumbing.
 *
 * Environment:
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   — Razorpay API credentials
 *   SUPABASE_URL, SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY              — standard Supabase wiring
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RZP_KEY_ID       = Deno.env.get('RAZORPAY_KEY_ID')     ?? '';
const RZP_KEY_SECRET   = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';

// Razorpay caps total_count at 100 for both periods. Monthly → ~8 years of
// renewals, annual → 100 years; either way the subscription auto-renews
// until the customer cancels via the portal or we cancel it server-side.
const RAZORPAY_TOTAL_COUNT = 100;

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

interface RazorpaySubscription {
  id:          string;
  entity:      'subscription';
  plan_id:     string;
  status:      string;
  quantity:    number;
  total_count: number;
  notes:       Record<string, string>;
  short_url?:  string;
}

async function createRazorpaySubscription(opts: {
  planId:       string;
  quantity:     number;
  notes:        Record<string, string>;
}): Promise<RazorpaySubscription> {
  const body = {
    plan_id:           opts.planId,
    total_count:       RAZORPAY_TOTAL_COUNT,
    quantity:          opts.quantity,
    customer_notify:   1,
    notes:             opts.notes,
  };

  const auth = btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`);
  const res = await fetch('https://api.razorpay.com/v1/subscriptions', {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Razorpay createSubscription failed (${res.status}): ${errBody}`);
  }

  return await res.json();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return err('Method not allowed', 405);

  // ── Razorpay credentials check (dormant mode) ─────────────────────────────
  // Surfaced first so the modal can show a friendly "payments unavailable"
  // banner without ever hitting auth or DB.
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    return err(
      'Razorpay not configured',
      503,
      {
        detail:
          'Online payments are not yet enabled. Please contact support to ' +
          'activate your subscription.',
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

  // ── Resolve caller's fleet ────────────────────────────────────────────────
  const { data: fleet, error: fleetErr } = await adminClient
    .from('fleets')
    .select('id')
    .eq('manager_id', user.id)
    .single();
  if (fleetErr || !fleet) return err('No fleet found for this account', 403);

  // ── Parse + validate body ─────────────────────────────────────────────────
  let body: { plan?: string; vehicle_count?: number; billing_cycle?: string };
  try {
    body = await req.json();
  } catch {
    return err('Invalid JSON body', 400);
  }

  const planName     = String(body.plan ?? '').trim();
  const vehicleCount = Number(body.vehicle_count);
  const billingCycle = String(body.billing_cycle ?? '').trim();

  if (!planName)                              return err('plan is required', 400);
  if (!Number.isFinite(vehicleCount) ||
      vehicleCount < 1 ||
      !Number.isInteger(vehicleCount))        return err('vehicle_count must be a positive integer', 400);
  if (billingCycle !== 'monthly' &&
      billingCycle !== 'annual')              return err('billing_cycle must be monthly or annual', 400);

  // ── Look up plan definition ───────────────────────────────────────────────
  const { data: planDef, error: planErr } = await adminClient
    .from('plan_definitions')
    .select(`
      plan_name, billing_model, is_active,
      price_per_vehicle_inr, min_vehicles, annual_discount_pct,
      razorpay_monthly_plan_id, razorpay_annual_plan_id
    `)
    .eq('plan_name', planName)
    .maybeSingle();

  if (planErr)             return err(planErr.message, 500);
  if (!planDef)            return err('Plan not found', 404);
  if (!planDef.is_active)  return err('Plan is not currently offered', 404);
  if (planDef.billing_model !== 'per_vehicle') {
    // Enterprise / custom plans go through the contact-sales path (1.2.5),
    // not online checkout.
    return err('Plan is not available for self-serve checkout', 404);
  }

  const minVehicles  = Number(planDef.min_vehicles ?? 1);
  const pricePerVeh  = Number(planDef.price_per_vehicle_inr ?? 0);
  if (vehicleCount < minVehicles) {
    return err(
      `Vehicle count below plan minimum`,
      422,
      { min_vehicles: minVehicles },
    );
  }

  const razorpayPlanId = billingCycle === 'annual'
    ? planDef.razorpay_annual_plan_id
    : planDef.razorpay_monthly_plan_id;

  if (!razorpayPlanId) {
    // Plans haven't been provisioned in Razorpay yet — operator needs to run
    // razorpay-provision-plans. Distinct from credentials-missing (503).
    return err(
      'Plan not yet linked to Razorpay',
      503,
      { detail: 'Operator needs to run razorpay-provision-plans for this plan/cycle.' },
    );
  }

  // ── Annual unlock gate (3-month rule) ─────────────────────────────────────
  if (billingCycle === 'annual') {
    const { data: sub } = await adminClient
      .from('subscriptions')
      .select('annual_unlocked_at')
      .eq('fleet_id', fleet.id)
      .maybeSingle();
    if (!sub?.annual_unlocked_at) {
      return err(
        'Annual billing not yet unlocked',
        422,
        {
          detail:
            'Annual billing unlocks after 3 months on monthly. ' +
            'Continue on monthly for now.',
        },
      );
    }
  }

  // ── Create Razorpay subscription ──────────────────────────────────────────
  // Notes intentionally use snake_case strings — Razorpay stores them verbatim
  // and razorpay-webhook reads them with the same keys. Do NOT rename these
  // without updating the webhook.
  const notes: Record<string, string> = {
    fleet_id:               String(fleet.id),
    plan:                   planName,
    billing_model:          'per_vehicle',
    billing_cycle:          billingCycle,
    vehicle_count:          String(vehicleCount),
    price_per_vehicle_inr:  String(pricePerVeh),
  };

  let rzpSub: RazorpaySubscription;
  try {
    rzpSub = await createRazorpaySubscription({
      planId:   razorpayPlanId,
      quantity: vehicleCount,
      notes,
    });
  } catch (e) {
    return err((e as Error).message, 502);
  }

  // ── Audit trail ───────────────────────────────────────────────────────────
  // Subscription record itself is upserted by razorpay-webhook on activation,
  // not here — until Razorpay confirms the first charge, nothing should look
  // "active" in our DB.
  await adminClient.from('audit_logs').insert({
    fleet_id:      fleet.id,
    user_id:       user.id,
    action:        'subscription.checkout_initiated',
    resource_type: 'subscription',
    new_values: {
      plan:                     planName,
      billing_cycle:            billingCycle,
      vehicle_count:            vehicleCount,
      price_per_vehicle_inr:    pricePerVeh,
      annual_discount_pct:      Number(planDef.annual_discount_pct ?? 0),
      razorpay_subscription_id: rzpSub.id,
    },
  });

  // Compute the up-front amount the customer will see in checkout — same
  // formula the modal uses, so any drift would show up immediately.
  const monthlyAmountPaise = Math.round(pricePerVeh * vehicleCount * 100);
  const annualAmountPaise  = Math.round(
    pricePerVeh * vehicleCount * 12 *
    (1 - Number(planDef.annual_discount_pct ?? 0) / 100) * 100,
  );
  const amountPaise = billingCycle === 'annual' ? annualAmountPaise : monthlyAmountPaise;

  return json({
    razorpay_subscription_id: rzpSub.id,
    key_id:                   RZP_KEY_ID,
    amount_paise:             amountPaise,
    currency:                 'INR',
  });
});

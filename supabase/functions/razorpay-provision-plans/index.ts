/**
 * razorpay-provision-plans edge function
 *
 * One-shot, idempotent Razorpay plan provisioning. Reads plan_definitions and,
 * for every active per_vehicle plan that doesn't yet have a Razorpay plan_id
 * for a billing cycle, creates the plan in Razorpay and writes the id back.
 *
 * Auth: requires X-Admin-Secret header (operator-only).
 * Run after deploying new pricing or after switching Razorpay accounts.
 *
 * Environment:
 *   RAZORPAY_KEY_ID       — Razorpay API key id  (live or test)
 *   RAZORPAY_KEY_SECRET   — Razorpay API key secret
 *   ADMIN_SECRET          — operator-only auth secret
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Returns 503 if Razorpay credentials are missing — safe to deploy before the
 * customer has a Razorpay account.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET     = Deno.env.get('ADMIN_SECRET') ?? '';
const RZP_KEY_ID       = Deno.env.get('RAZORPAY_KEY_ID')     ?? '';
const RZP_KEY_SECRET   = Deno.env.get('RAZORPAY_KEY_SECRET') ?? '';

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

// ─── Razorpay API ────────────────────────────────────────────────────────────

interface RazorpayPlanResponse {
  id:        string;
  entity:    'plan';
  interval:  number;
  period:    'monthly' | 'yearly';
  item:      { id: string; name: string; amount: number; currency: string };
  notes?:    Record<string, string>;
  created_at: number;
}

async function createRazorpayPlan(opts: {
  planName:     string;
  displayName:  string;
  amountPaise:  number;       // total amount in paise (e.g. 30000 = ₹300)
  period:       'monthly' | 'yearly';
  notes:        Record<string, string>;
}): Promise<RazorpayPlanResponse> {
  const body = {
    period:   opts.period,
    interval: 1,
    item: {
      name:        `${opts.displayName} (${opts.period})`,
      description: `${opts.displayName} plan billed ${opts.period}, per vehicle`,
      amount:      opts.amountPaise,
      currency:    'INR',
    },
    notes: opts.notes,
  };

  const auth = btoa(`${RZP_KEY_ID}:${RZP_KEY_SECRET}`);

  const res = await fetch('https://api.razorpay.com/v1/plans', {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Razorpay createPlan failed (${res.status}): ${errBody}`);
  }

  return await res.json();
}

// ─── Handler ─────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST')    return json({ error: 'Method not allowed' }, 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = req.headers.get('X-Admin-Secret') ?? '';
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ── Razorpay credentials check (dormant mode if missing) ──────────────────
  if (!RZP_KEY_ID || !RZP_KEY_SECRET) {
    return json({
      error: 'Razorpay not configured',
      detail:
        'Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as Supabase function secrets. ' +
        'See: supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=...',
    }, 503);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Fetch plans needing provisioning ──────────────────────────────────────
  const { data: plans, error: fetchErr } = await supabase
    .from('plan_definitions')
    .select(`
      plan_name, display_name, billing_model,
      price_per_vehicle_inr, annual_discount_pct,
      razorpay_monthly_plan_id, razorpay_annual_plan_id
    `)
    .eq('is_active', true)
    .eq('billing_model', 'per_vehicle');

  if (fetchErr) return json({ error: fetchErr.message }, 500);

  const created: Array<{ plan: string; cycle: string; razorpay_plan_id: string }> = [];
  const skipped: Array<{ plan: string; cycle: string; reason: string }>            = [];
  const failed:  Array<{ plan: string; cycle: string; error:  string }>            = [];

  for (const p of plans ?? []) {
    const price = p.price_per_vehicle_inr as number | null;
    if (price == null || price <= 0) {
      skipped.push({ plan: p.plan_name, cycle: '*', reason: 'no per-vehicle price' });
      continue;
    }

    // ── Monthly plan ────────────────────────────────────────────────────────
    if (!p.razorpay_monthly_plan_id) {
      try {
        const monthlyAmountPaise = Math.round(price * 100);
        const created_plan = await createRazorpayPlan({
          planName:    p.plan_name,
          displayName: p.display_name,
          amountPaise: monthlyAmountPaise,
          period:      'monthly',
          notes: {
            plan_name:     p.plan_name,
            billing_cycle: 'monthly',
            source:        'razorpay-provision-plans',
          },
        });
        await supabase
          .from('plan_definitions')
          .update({ razorpay_monthly_plan_id: created_plan.id, updated_at: new Date().toISOString() })
          .eq('plan_name', p.plan_name);
        created.push({ plan: p.plan_name, cycle: 'monthly', razorpay_plan_id: created_plan.id });
      } catch (e) {
        failed.push({ plan: p.plan_name, cycle: 'monthly', error: (e as Error).message });
      }
    } else {
      skipped.push({ plan: p.plan_name, cycle: 'monthly', reason: 'already provisioned' });
    }

    // ── Annual plan ─────────────────────────────────────────────────────────
    if (!p.razorpay_annual_plan_id) {
      try {
        const discount = Number(p.annual_discount_pct ?? 0);
        const annualPaise = Math.round(price * 12 * (1 - discount / 100) * 100);
        const created_plan = await createRazorpayPlan({
          planName:    p.plan_name,
          displayName: p.display_name,
          amountPaise: annualPaise,
          period:      'yearly',
          notes: {
            plan_name:        p.plan_name,
            billing_cycle:    'annual',
            annual_discount:  String(discount),
            source:           'razorpay-provision-plans',
          },
        });
        await supabase
          .from('plan_definitions')
          .update({ razorpay_annual_plan_id: created_plan.id, updated_at: new Date().toISOString() })
          .eq('plan_name', p.plan_name);
        created.push({ plan: p.plan_name, cycle: 'annual', razorpay_plan_id: created_plan.id });
      } catch (e) {
        failed.push({ plan: p.plan_name, cycle: 'annual', error: (e as Error).message });
      }
    } else {
      skipped.push({ plan: p.plan_name, cycle: 'annual', reason: 'already provisioned' });
    }
  }

  return json({
    ok:      failed.length === 0,
    created,
    skipped,
    failed,
  }, failed.length === 0 ? 200 : 207);
});

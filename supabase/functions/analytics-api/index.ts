/**
 * analytics-api edge function
 *
 * Operator-only analytics endpoint. Reads from the postgres views shipped
 * by 20260605000000_analytics_views.sql (Phase 2.1) and returns aggregate
 * revenue + plan distribution numbers.
 *
 * Auth: requires X-Admin-Secret header (operator-only, same secret as
 * razorpay-provision-plans / admin-api override paths). Customer-facing
 * data isn't exposed here — every customer's own usage lives behind
 * fleet-scoped RLS in the existing endpoints.
 *
 * Routes:
 *   GET ?action=summary
 *     {
 *       mrr_inr, arr_inr,                             // global topline
 *       paid_active_subs, trial_active_subs, total_subs,
 *       plan_distribution: [{plan, active_count, trial_count, mrr_inr}, ...],
 *       new_paid_subs_daily: [{day, new_paid_subs}, ...],   // 30 days, zero-filled
 *       generated_at: ISO timestamp
 *     }
 *
 * Future routes (Phase 2.2): conversion funnel, churn cohorts, cashback ROI.
 *
 * Environment:
 *   ADMIN_SECRET                            — operator-only auth secret
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — standard wiring
 */

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_SECRET     = Deno.env.get('ADMIN_SECRET') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-admin-secret',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'GET')     return json({ error: 'Method not allowed' }, 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = req.headers.get('X-Admin-Secret') ?? '';
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
    return json({ error: 'Forbidden' }, 403);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const url    = new URL(req.url);
  const action = url.searchParams.get('action') ?? '';

  // ── GET ?action=summary ───────────────────────────────────────────────────
  if (action === 'summary') {
    // Three views queried in parallel — they're independent and the round
    // trip dominates the cost.
    const [globalRes, planRes, dailyRes] = await Promise.all([
      supabase.from('analytics_global_mrr').select('*').single(),
      supabase.from('analytics_plan_distribution').select('*'),
      supabase.from('analytics_new_paid_subs_daily').select('*'),
    ]);

    if (globalRes.error) return json({ error: globalRes.error.message }, 500);
    if (planRes.error)   return json({ error: planRes.error.message },   500);
    if (dailyRes.error)  return json({ error: dailyRes.error.message },  500);

    return json({
      // Global topline.
      mrr_inr:           Number(globalRes.data?.mrr_inr           ?? 0),
      arr_inr:           Number(globalRes.data?.arr_inr           ?? 0),
      paid_active_subs:  Number(globalRes.data?.paid_active_subs  ?? 0),
      trial_active_subs: Number(globalRes.data?.trial_active_subs ?? 0),
      total_subs:        Number(globalRes.data?.total_subs        ?? 0),

      // Per-plan breakdown.
      plan_distribution: (planRes.data ?? []).map(r => ({
        plan:         r.plan,
        active_count: Number(r.active_count ?? 0),
        trial_count:  Number(r.trial_count  ?? 0),
        mrr_inr:      Number(r.mrr_inr      ?? 0),
      })),

      // 30-day rolling series, zero-filled by the view.
      new_paid_subs_daily: (dailyRes.data ?? []).map(r => ({
        day:           r.day,
        new_paid_subs: Number(r.new_paid_subs ?? 0),
      })),

      // Stamp the response so the dashboard can show "as of X" — these
      // views are computed live, so it's effectively the wall-clock at
      // query time. Useful when the operator screenshots for a deck.
      generated_at: new Date().toISOString(),
    });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});

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
 *       // Phase 2.1 (#74)
 *       mrr_inr, arr_inr,                             // global topline
 *       paid_active_subs, trial_active_subs, total_subs,
 *       plan_distribution:    [{plan, active_count, trial_count, mrr_inr}, ...],
 *       new_paid_subs_daily:  [{day, new_paid_subs}, ...],   // 30 days, zero-filled
 *
 *       // Phase 2.2
 *       conversion_funnel:    [{plan, signed_up, trial_completed, paid_ever, paid_now}, ...],
 *       cashback_roi:         {granted_count, granted_inr, redeemed_count, redeemed_inr,
 *                              expired_count, expired_inr, pending_count, pending_inr,
 *                              redemption_pct},
 *
 *       // Phase 2.3
 *       cohort_retention_curves: [{cohort_month, offset_months, cohort_size,
 *                                  active_count, retention_pct}, ...],
 *
 *       generated_at:         ISO timestamp
 *     }
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
    // Six views queried in parallel — independent reads, round trip dominates.
    // Phase 2.1 added the first three; Phase 2.2 adds the funnel + cohorts +
    // cashback. Folding them all into one response keeps the dashboard a
    // single fetch.
    const [
      globalRes, planRes, dailyRes,
      funnelRes, cashbackRes,
      curvesRes,
    ] = await Promise.all([
      supabase.from('analytics_global_mrr').select('*').single(),
      supabase.from('analytics_plan_distribution').select('*'),
      supabase.from('analytics_new_paid_subs_daily').select('*'),
      supabase.from('analytics_conversion_funnel').select('*'),
      supabase.from('analytics_cashback_roi').select('*').single(),
      supabase.from('analytics_cohort_retention_curves').select('*'),
    ]);

    if (globalRes.error)   return json({ error: globalRes.error.message },   500);
    if (planRes.error)     return json({ error: planRes.error.message },     500);
    if (dailyRes.error)    return json({ error: dailyRes.error.message },    500);
    if (funnelRes.error)   return json({ error: funnelRes.error.message },   500);
    if (cashbackRes.error) return json({ error: cashbackRes.error.message }, 500);
    if (curvesRes.error)   return json({ error: curvesRes.error.message },   500);

    return json({
      // ── Global topline (Phase 2.1) ──────────────────────────────────────
      mrr_inr:           Number(globalRes.data?.mrr_inr           ?? 0),
      arr_inr:           Number(globalRes.data?.arr_inr           ?? 0),
      paid_active_subs:  Number(globalRes.data?.paid_active_subs  ?? 0),
      trial_active_subs: Number(globalRes.data?.trial_active_subs ?? 0),
      total_subs:        Number(globalRes.data?.total_subs        ?? 0),

      plan_distribution: (planRes.data ?? []).map(r => ({
        plan:         r.plan,
        active_count: Number(r.active_count ?? 0),
        trial_count:  Number(r.trial_count  ?? 0),
        mrr_inr:      Number(r.mrr_inr      ?? 0),
      })),

      new_paid_subs_daily: (dailyRes.data ?? []).map(r => ({
        day:           r.day,
        new_paid_subs: Number(r.new_paid_subs ?? 0),
      })),

      // ── Conversion funnel, last 90 days (Phase 2.2) ─────────────────────
      // Includes a synthetic '__overall__' row plus per-plan rows. The
      // dashboard splits on plan === '__overall__' to pull the topline.
      conversion_funnel: (funnelRes.data ?? []).map(r => ({
        plan:            r.plan,
        signed_up:       Number(r.signed_up       ?? 0),
        trial_completed: Number(r.trial_completed ?? 0),
        paid_ever:       Number(r.paid_ever       ?? 0),
        paid_now:        Number(r.paid_now        ?? 0),
      })),

      // ── Cohort retention curves (Phase 2.3) ─────────────────────────────
      // Replaces the Phase 2.2 single-point `paid_cohorts` field, which
      // was dropped in cleanup migration 20260608000000 along with its
      // backing view. Old consumers had one PR cycle of overlap.
      // Reads subscription_snapshots, so curves fill in over TIME — at the
      // 2.3 migration's apply moment only M0 has data; each subsequent day
      // adds one column of fidelity. The dashboard renders missing cells
      // as empty rather than zero, so the operator sees the gap honestly.
      cohort_retention_curves: (curvesRes.data ?? []).map(r => ({
        cohort_month:   r.cohort_month,
        offset_months:  Number(r.offset_months  ?? 0),
        cohort_size:    Number(r.cohort_size    ?? 0),
        active_count:   Number(r.active_count   ?? 0),
        retention_pct:  Number(r.retention_pct  ?? 0),
      })),

      // ── Cashback ROI (Phase 2.2) ────────────────────────────────────────
      cashback_roi: {
        granted_count:   Number(cashbackRes.data?.granted_count   ?? 0),
        granted_inr:     Number(cashbackRes.data?.granted_inr     ?? 0),
        redeemed_count:  Number(cashbackRes.data?.redeemed_count  ?? 0),
        redeemed_inr:    Number(cashbackRes.data?.redeemed_inr    ?? 0),
        expired_count:   Number(cashbackRes.data?.expired_count   ?? 0),
        expired_inr:     Number(cashbackRes.data?.expired_inr     ?? 0),
        pending_count:   Number(cashbackRes.data?.pending_count   ?? 0),
        pending_inr:     Number(cashbackRes.data?.pending_inr     ?? 0),
        redemption_pct:  Number(cashbackRes.data?.redemption_pct  ?? 0),
      },

      // Stamp the response so the dashboard can show "as of X" — these
      // views are computed live, so it's effectively the wall-clock at
      // query time. Useful when the operator screenshots for a deck.
      generated_at: new Date().toISOString(),
    });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});

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
 *       cohort_data_materialized_at: ISO timestamp     // when the materialized view was last refreshed
 *
 *       // Phase 2.4
 *       mrr_history:                 [{day, mrr_inr, paid_active_subs, trial_active_subs}, ...],
 *       mrr_history_materialized_at: ISO timestamp
 *
 *       // Phase 2.5
 *       mrr_history_by_plan:                 [{day, plan, mrr_inr, paid_active_subs}, ...],
 *       mrr_history_by_plan_materialized_at: ISO timestamp
 *
 *       // Phase 3.9 — failed payment dunning surface
 *       failed_payments:      [{audit_id, fleet_id, fleet_name, manager_email,
 *                               amount_inr, error_code, error_description,
 *                               failed_at, current_status, days_since_failed}, ...]
 *
 *       // Phase 3.10 — cancellation reasons (last 90 days)
 *       cancellation_reasons:        [{reason, count, pct}, ...]
 *       cancellation_recent_comments:[{requested_at, reason, comment}, ...]
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
    // Eight views queried in parallel — independent reads, round trip
    // dominates. Phase 2.1 added the first three; 2.2 the funnel + cohorts
    // + cashback; 2.3 the cohort curves; 2.4 the MRR history; 2.5 the
    // per-plan MRR history. Folding them all into one response keeps the
    // dashboard a single fetch.
    // ── Failed-payments lookback (Phase 3.9) ────────────────────────────
    // Operator dunning view: surface every audit-log entry tagged
    // subscription.payment_failed in the last 30 days. The webhook writes
    // these, the dashboard renders them. 30 days matches the cron-driven
    // grace window before a suspended sub becomes inactive.
    const FAILED_LOOKBACK_DAYS = 30;
    const failedSinceIso = new Date(
      Date.now() - FAILED_LOOKBACK_DAYS * 86_400_000,
    ).toISOString();
    const [
      globalRes, planRes, dailyRes,
      funnelRes, cashbackRes,
      curvesRes,
      mrrHistoryRes,
      mrrByPlanRes,
      failedRes,
      cancelReasonsRes,
      cancelCommentsRes,
    ] = await Promise.all([
      supabase.from('analytics_global_mrr').select('*').single(),
      supabase.from('analytics_plan_distribution').select('*'),
      supabase.from('analytics_new_paid_subs_daily').select('*'),
      supabase.from('analytics_conversion_funnel').select('*'),
      supabase.from('analytics_cashback_roi').select('*').single(),
      supabase.from('analytics_cohort_retention_curves').select('*'),
      supabase.from('analytics_mrr_history').select('*'),
      supabase.from('analytics_mrr_history_by_plan').select('*'),
      // Pull failed-payment audit rows + the joined fleet name. We don't
      // join auth.users here because PostgREST can't traverse the auth
      // schema via FK select, and we don't join subscriptions in the same
      // statement either — the chain `audit_logs.fleet_id → fleets.id ←
      // subscriptions.fleet_id` isn't a single foreign-key edge from the
      // perspective of audit_logs. Both enrichments happen in cheap
      // follow-up steps below.
      supabase.from('audit_logs')
        .select('id, fleet_id, new_values, created_at, fleets(name, manager_id)')
        .eq('action', 'subscription.payment_failed')
        .gte('created_at', failedSinceIso)
        .order('created_at', { ascending: false })
        .limit(200),
      // ── Cancellation reasons (Phase 3.10) ───────────────────────────────
      // The aggregated bucket counts come from the view; recent free-text
      // comments come from the same audit-log table directly. Comments
      // are the qualitative signal — buckets tell ops what, comments tell
      // them why. We reuse `failedSinceIso` as the comment lookback window
      // by coincidence — the cancellation-reasons VIEW uses 90 days but
      // we cap the comment surface at the same 30-day recency window so
      // the dashboard shows freshly-relevant qualitative signal next to
      // the quantitative aggregate.
      supabase.from('analytics_cancellation_reasons').select('*'),
      supabase.from('audit_logs')
        .select('created_at, new_values')
        .eq('action', 'subscription.cancellation_requested')
        .gte('created_at', failedSinceIso)
        .not('new_values->>comment', 'is', null)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);

    if (globalRes.error)     return json({ error: globalRes.error.message },     500);
    if (planRes.error)       return json({ error: planRes.error.message },       500);
    if (dailyRes.error)      return json({ error: dailyRes.error.message },      500);
    if (funnelRes.error)     return json({ error: funnelRes.error.message },     500);
    if (cashbackRes.error)   return json({ error: cashbackRes.error.message },   500);
    if (curvesRes.error)     return json({ error: curvesRes.error.message },     500);
    if (mrrHistoryRes.error) return json({ error: mrrHistoryRes.error.message }, 500);
    if (mrrByPlanRes.error)  return json({ error: mrrByPlanRes.error.message },  500);
    if (failedRes.error)         return json({ error: failedRes.error.message },         500);
    if (cancelReasonsRes.error)  return json({ error: cancelReasonsRes.error.message },  500);
    if (cancelCommentsRes.error) return json({ error: cancelCommentsRes.error.message }, 500);

    // ── Build failed_payments slice ───────────────────────────────────────
    // Resolve manager_email per row via auth.admin.getUserById. Cache by
    // user_id so repeat fleets (multiple failures from the same fleet)
    // don't double-fetch. The lookup is per-row but that's OK for ≤200
    // rows in 30 days at our scale; if this ever gets hot, swap to a
    // materialized analytics_failed_payments view that joins through
    // a server-side function.
    const emailCache = new Map<string, string | null>();
    const resolveEmail = async (managerId: string | null): Promise<string | null> => {
      if (!managerId) return null;
      if (emailCache.has(managerId)) return emailCache.get(managerId)!;
      try {
        const { data: userRes } = await supabase.auth.admin.getUserById(managerId);
        const email = userRes?.user?.email ?? null;
        emailCache.set(managerId, email);
        return email;
      } catch {
        emailCache.set(managerId, null);
        return null;
      }
    };

    const nowMs = Date.now();
    const failedRaw = (failedRes.data ?? []) as unknown as Array<{
      id:          string;
      fleet_id:    string | null;
      new_values:  Record<string, unknown> | null;
      created_at:  string;
      // PostgREST returns the joined row as an array when the FK is on the
      // child side (fleets here is the parent — but the runtime shape can
      // vary across supabase-js versions). Tolerate both for safety.
      fleets:      { name: string | null; manager_id: string | null }
                 | { name: string | null; manager_id: string | null }[]
                 | null;
    }>;

    // Fetch current sub status for every distinct fleet that has a recent
    // failure — one round trip, then look up by fleet_id. Lets the dashboard
    // distinguish "still suspended" from "recovered after a retry".
    const distinctFleetIds = Array.from(new Set(
      failedRaw.map(r => r.fleet_id).filter((x): x is string => !!x),
    ));
    const subStatusByFleet = new Map<string, string>();
    if (distinctFleetIds.length > 0) {
      const { data: subRows } = await supabase
        .from('subscriptions')
        .select('fleet_id, status')
        .in('fleet_id', distinctFleetIds);
      for (const r of (subRows ?? []) as Array<{ fleet_id: string; status: string }>) {
        subStatusByFleet.set(r.fleet_id, r.status);
      }
    }

    const failedPayments = await Promise.all(failedRaw.map(async row => {
      const v = row.new_values ?? {};
      const fleetEntity = Array.isArray(row.fleets) ? row.fleets[0] ?? null : row.fleets;
      const subStatus = row.fleet_id ? subStatusByFleet.get(row.fleet_id) ?? null : null;
      const managerEmail = await resolveEmail(fleetEntity?.manager_id ?? null);
      const failedAt = String(v.failed_at ?? row.created_at);
      const daysSince = Math.floor((nowMs - new Date(failedAt).getTime()) / 86_400_000);
      return {
        audit_id:           row.id,
        fleet_id:           row.fleet_id,
        fleet_name:         fleetEntity?.name ?? null,
        manager_email:      managerEmail,
        amount_inr:         Number(v.amount_inr ?? 0),
        currency:           (v.currency as string)          ?? 'INR',
        error_code:         (v.error_code as string)        ?? null,
        error_description:  (v.error_description as string) ?? null,
        error_reason:       (v.error_reason as string)      ?? null,
        payment_id:         (v.payment_id as string)        ?? null,
        failed_at:          failedAt,
        current_status:     subStatus,
        days_since_failed:  Math.max(0, daysSince),
      };
    }));

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

      // ── Cohort retention curves (Phase 2.3, materialized in 20260609) ──
      // The view was promoted to MATERIALIZED — it cross-joins cohorts ×
      // 12 offsets and DISTINCT-ONs over snapshots, so its runtime grows
      // linearly with the snapshots table. Refreshed daily at 00:30 UTC
      // by pg_cron. Plain views in this surface remain plain — they
      // aggregate over `subscriptions` (small), sub-ms even at scale.
      //
      // `materialized_at` is `now()` frozen at REFRESH time, identical
      // across every row. Read it off the first row; falls back to null
      // when the view is empty (dashboard handles both).
      cohort_retention_curves: (curvesRes.data ?? []).map(r => ({
        cohort_month:   r.cohort_month,
        offset_months:  Number(r.offset_months  ?? 0),
        cohort_size:    Number(r.cohort_size    ?? 0),
        active_count:   Number(r.active_count   ?? 0),
        retention_pct:  Number(r.retention_pct  ?? 0),
      })),
      cohort_data_materialized_at:
        (curvesRes.data?.[0]?.materialized_at as string | undefined) ?? null,

      // ── MRR history (Phase 2.4) ─────────────────────────────────────────
      // 90-day daily series reconstructed from `subscription_snapshots ×
      // plan_definitions`. Materialized + nightly-refreshed (00:35 UTC).
      // `materialized_at` is per-row identical, read off the first row.
      mrr_history: (mrrHistoryRes.data ?? []).map(r => ({
        day:               r.day,
        mrr_inr:           Number(r.mrr_inr           ?? 0),
        paid_active_subs:  Number(r.paid_active_subs  ?? 0),
        trial_active_subs: Number(r.trial_active_subs ?? 0),
      })),
      mrr_history_materialized_at:
        (mrrHistoryRes.data?.[0]?.materialized_at as string | undefined) ?? null,

      // ── Per-plan MRR history (Phase 2.5) ────────────────────────────────
      // Long format (one row per day × plan). Dashboard pivots client-side
      // for the stacked area chart so the plan list stays dynamic — adding
      // a new plan to plan_definitions doesn't need an API change.
      // Materialized + nightly-refreshed (00:40 UTC).
      mrr_history_by_plan: (mrrByPlanRes.data ?? []).map(r => ({
        day:              r.day,
        plan:             r.plan,
        mrr_inr:          Number(r.mrr_inr          ?? 0),
        paid_active_subs: Number(r.paid_active_subs ?? 0),
      })),
      mrr_history_by_plan_materialized_at:
        (mrrByPlanRes.data?.[0]?.materialized_at as string | undefined) ?? null,

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

      // ── Failed payments (Phase 3.9) ─────────────────────────────────────
      // Last 30 days of payment.failed audit rows enriched with fleet name,
      // manager email, current subscription status, and days_since_failed.
      // Sorted newest-first so the dashboard table doesn't have to.
      failed_payments: failedPayments,

      // ── Cancellation reasons (Phase 3.10) ───────────────────────────────
      // 90-day aggregate: bucket counts + share, plus the most recent free-
      // text comments customers wrote when cancelling. Buckets tell ops
      // WHAT, comments tell them WHY. Empty arrays for fresh installs.
      cancellation_reasons: (cancelReasonsRes.data ?? []).map(r => ({
        reason: r.reason as string,
        count:  Number(r.count ?? 0),
        pct:    Number(r.pct   ?? 0),
      })),
      cancellation_recent_comments: (cancelCommentsRes.data ?? []).map(r => {
        const v = (r.new_values ?? {}) as Record<string, unknown>;
        return {
          requested_at: r.created_at as string,
          reason:       (v.reason  as string) ?? 'other',
          // Cap at 280 chars on the wire — operators don't need novellas
          // and a wide-open string field is a footgun if someone pastes a
          // multi-page rant. The DB constraint is 500 already; we just
          // shorten for the dashboard rendering.
          comment:      String(v.comment ?? '').slice(0, 280),
        };
      }),

      // Stamp the response so the dashboard can show "as of X" — these
      // views are computed live, so it's effectively the wall-clock at
      // query time. Useful when the operator screenshots for a deck.
      generated_at: new Date().toISOString(),
    });
  }

  return json({ error: `Unknown action: ${action}` }, 400);
});

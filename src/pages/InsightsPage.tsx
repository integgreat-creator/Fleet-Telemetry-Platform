import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid,
} from 'recharts';
import { TrendingUp, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import AdminSecretGate, { useAdminSecret } from '../components/AdminSecretGate';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PlanDistRow {
  plan:         string;
  active_count: number;
  trial_count:  number;
  mrr_inr:      number;
}

interface DailyRow {
  day:           string;
  new_paid_subs: number;
}

interface FunnelRow {
  plan:            string;     // '__overall__' for the topline aggregate
  signed_up:       number;
  trial_completed: number;
  paid_ever:       number;
  paid_now:        number;
}

interface CohortRow {
  cohort_month:  string;       // YYYY-MM-DD (first of month)
  cohort_size:   number;
  retained_now:  number;
  retention_pct: number;
}

/// One cell in the retention heatmap: cohort × month-offset.
/// Phase 2.3.
interface CurvePoint {
  cohort_month:   string;      // YYYY-MM-DD (first of cohort month)
  offset_months:  number;      // 0..11
  cohort_size:    number;
  active_count:   number;
  retention_pct:  number;
}

interface CashbackRoi {
  granted_count:   number;
  granted_inr:     number;
  redeemed_count:  number;
  redeemed_inr:    number;
  expired_count:   number;
  expired_inr:     number;
  pending_count:   number;
  pending_inr:     number;
  redemption_pct:  number;
}

interface SummaryResponse {
  mrr_inr:               number;
  arr_inr:               number;
  paid_active_subs:      number;
  trial_active_subs:     number;
  total_subs:            number;
  plan_distribution:     PlanDistRow[];
  new_paid_subs_daily:   DailyRow[];
  conversion_funnel:        FunnelRow[];
  paid_cohorts:             CohortRow[];
  cashback_roi:             CashbackRoi;
  cohort_retention_curves:  CurvePoint[];
  generated_at:             string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/// Big numbers > ₹1 lakh get the standard Indian abbreviation (1.2L / 4.5Cr)
/// for the topline tiles — full digits stay readable in the table below.
function formatInrCompact(n: number): string {
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)}Cr`;
  if (n >= 100_000)    return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000)      return `₹${(n / 1_000).toFixed(1)}K`;
  return formatInr(n);
}

function formatDayShort(iso: string): string {
  // The view emits YYYY-MM-DD strings; new Date('2026-04-15') parses
  // unambiguously without timezone surprises.
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short',
  });
}

function formatMonthShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    month: 'short', year: 'numeric',
  });
}

/// "X% (numerator/denominator)" — used for inline funnel-stage labels.
/// numerator can be 0; denominator must not be (callers guard).
function formatPctOf(num: number, denom: number): string {
  if (denom === 0) return '—';
  return `${Math.round((num / denom) * 1000) / 10}%`;
}

// ─── API call ────────────────────────────────────────────────────────────────

async function fetchSummary(adminSecret: string): Promise<SummaryResponse> {
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analytics-api?action=summary`;
  const res = await fetch(url, {
    method:  'GET',
    headers: {
      'X-Admin-Secret': adminSecret,
      'apikey':         import.meta.env.VITE_SUPABASE_ANON_KEY,
      'Authorization':  `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      res.status === 403
        ? 'Admin secret rejected. Lock the dashboard and re-enter.'
        : `Analytics API ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return await res.json();
}

// ─── Tiles ───────────────────────────────────────────────────────────────────

interface TileProps {
  label:    string;
  value:    string;
  hint?:    string;
  accent?:  'blue' | 'green' | 'gray';
}

function Tile({ label, value, hint, accent = 'gray' }: TileProps) {
  const accentClasses = {
    blue:  'border-blue-900/60  bg-blue-950/20',
    green: 'border-green-900/60 bg-green-950/20',
    gray:  'border-gray-800     bg-gray-900',
  }[accent];

  return (
    <div className={`rounded-xl border ${accentClasses} p-5 space-y-1`}>
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function InsightsBody() {
  const adminSecret               = useAdminSecret();
  const [data,    setData]        = useState<SummaryResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error,   setError]       = useState<string | null>(null);

  const refresh = async () => {
    if (!adminSecret) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await fetchSummary(adminSecret);
      setData(summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // adminSecret is stable per session — only changes on lock+unlock,
    // which remounts the whole subtree via the gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500">
        <Loader2 size={20} className="animate-spin mr-2" />
        Loading analytics…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-xl bg-red-950/40 border border-red-900/60">
        <AlertCircle size={18} className="text-red-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-red-200">{error}</p>
          <button
            onClick={refresh}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-red-300 hover:text-red-100 border border-red-900 rounded-md hover:border-red-700 transition-colors"
          >
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const generatedAt = new Date(data.generated_at).toLocaleString('en-IN');
  const totalNewSubs30d = data.new_paid_subs_daily.reduce((s, d) => s + d.new_paid_subs, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 mb-1">
            <div className="p-2 rounded-lg bg-yellow-500/15">
              <TrendingUp className="text-yellow-400" size={18} />
            </div>
            <h1 className="text-2xl font-bold text-white">Insights</h1>
            <span className="text-[10px] uppercase tracking-widest text-yellow-400 font-semibold border border-yellow-700/50 rounded-full px-2 py-0.5">
              Operator
            </span>
          </div>
          <p className="text-xs text-gray-500 ml-11">As of {generatedAt}</p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs font-medium rounded-lg transition-colors"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Topline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile
          label="MRR"
          value={formatInrCompact(data.mrr_inr)}
          hint={formatInr(data.mrr_inr)}
          accent="green"
        />
        <Tile
          label="ARR"
          value={formatInrCompact(data.arr_inr)}
          hint={formatInr(data.arr_inr)}
          accent="blue"
        />
        <Tile
          label="Paid active subs"
          value={String(data.paid_active_subs)}
          hint={`${data.trial_active_subs} on trial`}
        />
        <Tile
          label="New paid (30d)"
          value={String(totalNewSubs30d)}
          hint="status flipped to active"
        />
      </div>

      {/* Plan distribution */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Plan distribution</h2>
          <span className="text-xs text-gray-500">Active subscriptions per plan</span>
        </div>
        {data.plan_distribution.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-8">No plan data yet.</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.plan_distribution}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: 24 }}
              >
                <CartesianGrid stroke="#1f2937" horizontal={false} />
                <XAxis type="number" stroke="#6b7280" fontSize={11} />
                <YAxis
                  type="category"
                  dataKey="plan"
                  stroke="#9ca3af"
                  fontSize={12}
                  width={90}
                />
                <Tooltip
                  cursor={{ fill: '#1f2937' }}
                  contentStyle={{
                    backgroundColor: '#0b0f19',
                    border:          '1px solid #1f2937',
                    borderRadius:    '0.5rem',
                    fontSize:        12,
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === 'mrr_inr') return [formatInr(value), 'MRR'];
                    return [value, name === 'active_count' ? 'Active' : 'Trial'];
                  }}
                />
                <Bar dataKey="active_count" stackId="subs" fill="#10b981" />
                <Bar dataKey="trial_count"  stackId="subs" fill="#6b7280" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Per-plan MRR table — bar chart shows counts; numbers live here */}
        <div className="mt-4 border-t border-gray-800 pt-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1.5 font-medium">Plan</th>
                <th className="py-1.5 font-medium text-right">Active</th>
                <th className="py-1.5 font-medium text-right">Trial</th>
                <th className="py-1.5 font-medium text-right">MRR</th>
              </tr>
            </thead>
            <tbody className="text-gray-300">
              {data.plan_distribution.map(row => (
                <tr key={row.plan} className="border-t border-gray-800/60">
                  <td className="py-1.5 font-medium capitalize">{row.plan}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.active_count}</td>
                  <td className="py-1.5 text-right tabular-nums text-gray-500">{row.trial_count}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInr(row.mrr_inr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Daily activations trend */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">New paid subscriptions</h2>
          <span className="text-xs text-gray-500">Last 30 days</span>
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data.new_paid_subs_daily}
              margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="#1f2937" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDayShort}
                stroke="#6b7280"
                fontSize={11}
                interval="preserveStartEnd"
              />
              <YAxis stroke="#6b7280" fontSize={11} allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0b0f19',
                  border:          '1px solid #1f2937',
                  borderRadius:    '0.5rem',
                  fontSize:        12,
                }}
                labelFormatter={formatDayShort}
                formatter={(value: number) => [value, 'New paid']}
              />
              <Line
                type="monotone"
                dataKey="new_paid_subs"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={{ r: 2 }}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Conversion funnel (Phase 2.2) ────────────────────────────────── */}
      <ConversionFunnelSection rows={data.conversion_funnel} />

      {/* ── Cohort retention heatmap (Phase 2.3) ─────────────────────────── */}
      {/* Replaces the Phase 2.2 single-point cohort table. The new view
          reads from subscription_snapshots so we get historical M0/M1/...
          retention rather than just "active right now". Curves fill in
          over time — older cohorts have more columns populated, newer
          cohorts only have M0 for now. */}
      <CohortHeatmapSection points={data.cohort_retention_curves} />

      {/* ── Cashback ROI (Phase 2.2) ─────────────────────────────────────── */}
      <CashbackRoiSection roi={data.cashback_roi} />
    </div>
  );
}

// ─── Conversion funnel section ──────────────────────────────────────────────

/// Renders the topline 4-stage funnel as a horizontal bar series, plus a
/// per-plan numbers table beneath. Splits the synthetic '__overall__' row
/// from per-plan rows server-side so the chart never double-counts.
function ConversionFunnelSection({ rows }: { rows: FunnelRow[] }) {
  const overall  = rows.find(r => r.plan === '__overall__');
  const perPlan  = rows.filter(r => r.plan !== '__overall__');

  // Bar chart input — one bar per stage.
  const stages = overall ? [
    { stage: 'Signed up',       count: overall.signed_up },
    { stage: 'Trial completed', count: overall.trial_completed },
    { stage: 'Paid (ever)',     count: overall.paid_ever },
    { stage: 'Active now',      count: overall.paid_now },
  ] : [];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Conversion funnel</h2>
        <span className="text-xs text-gray-500">Last 90 days</span>
      </div>

      {!overall || overall.signed_up === 0 ? (
        <p className="text-sm text-gray-500 text-center py-8">No signups in the last 90 days.</p>
      ) : (
        <>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={stages}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 4, left: 24 }}
              >
                <CartesianGrid stroke="#1f2937" horizontal={false} />
                <XAxis type="number" stroke="#6b7280" fontSize={11} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="stage"
                  stroke="#9ca3af"
                  fontSize={12}
                  width={120}
                />
                <Tooltip
                  cursor={{ fill: '#1f2937' }}
                  contentStyle={{
                    backgroundColor: '#0b0f19',
                    border:          '1px solid #1f2937',
                    borderRadius:    '0.5rem',
                    fontSize:        12,
                  }}
                  formatter={(value: number) => [value, 'Fleets']}
                />
                {/* Funnel colour darkens slightly per stage as a visual cue
                    that we're descending toward the conversion event — a
                    proper funnel shape would need a custom shape, not worth
                    the complexity at v1. */}
                <Bar dataKey="count" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Per-plan numbers table — chart shows the topline shape; this
              gives the plan-by-plan accuracy the chart can't. */}
          {perPlan.length > 0 && (
            <div className="mt-4 border-t border-gray-800 pt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1.5 font-medium">Plan</th>
                    <th className="py-1.5 font-medium text-right">Signed up</th>
                    <th className="py-1.5 font-medium text-right">Paid ever</th>
                    <th className="py-1.5 font-medium text-right">Active now</th>
                    <th className="py-1.5 font-medium text-right">Conv.</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  {perPlan.map(row => (
                    <tr key={row.plan} className="border-t border-gray-800/60">
                      <td className="py-1.5 font-medium capitalize">{row.plan}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.signed_up}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.paid_ever}</td>
                      <td className="py-1.5 text-right tabular-nums">{row.paid_now}</td>
                      <td className="py-1.5 text-right tabular-nums text-blue-400">
                        {formatPctOf(row.paid_ever, row.signed_up)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Cohort retention heatmap (Phase 2.3) ──────────────────────────────────

/// Bucket retention percentage into a tailwind background colour. Wide
/// gradient because the eye reads "retention shape" by colour, not number —
/// the operator scans down columns to spot a cohort that fell off a cliff
/// at M3, vs sustained.
function bucketColour(pct: number): string {
  if (pct >= 95) return 'bg-emerald-500';
  if (pct >= 80) return 'bg-emerald-600';
  if (pct >= 65) return 'bg-yellow-600';
  if (pct >= 50) return 'bg-orange-600';
  if (pct >= 25) return 'bg-red-600';
  return 'bg-red-700';
}

/// Cohort retention heatmap. Rows = cohort months (newest at top), columns
/// = month-offset 0..11. Cells show retention % colour-coded by bucket;
/// missing cells (offset hasn't elapsed yet OR snapshots table is younger
/// than the cohort + offset) render as a gray dash so the operator can see
/// the data gap honestly.
function CohortHeatmapSection({ points }: { points: CurvePoint[] }) {
  if (points.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-semibold text-white">Paid cohort retention</h2>
          <span className="text-xs text-gray-500">Last 12 months · M0–M11 from snapshots</span>
        </div>
        <p className="text-sm text-gray-500 text-center py-8">No paid cohorts yet.</p>
      </div>
    );
  }

  // Reshape into a {cohortMonth: {offset: retention_pct, _size}} map for
  // O(1) cell lookup during render.
  const cohortMonths = Array.from(new Set(points.map(p => p.cohort_month)));
  // Newest cohort first.
  cohortMonths.sort((a, b) => b.localeCompare(a));

  const cohortSize = new Map<string, number>();
  const cell       = new Map<string, CurvePoint>();
  for (const p of points) {
    cohortSize.set(p.cohort_month, p.cohort_size);
    cell.set(`${p.cohort_month}|${p.offset_months}`, p);
  }

  const offsets = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Paid cohort retention</h2>
        <span className="text-xs text-gray-500">Last 12 months · M0–M11 from snapshots</span>
      </div>

      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="py-1.5 px-2 text-left font-medium sticky left-0 bg-gray-900 z-10">
                Cohort
              </th>
              <th className="py-1.5 px-2 text-right font-medium">Size</th>
              {offsets.map(o => (
                <th key={o} className="py-1.5 px-2 text-center font-medium tabular-nums w-12">
                  M{o}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohortMonths.map(cm => (
              <tr key={cm}>
                <td className="py-1 px-2 font-medium text-gray-300 sticky left-0 bg-gray-900 z-10 whitespace-nowrap">
                  {formatMonthShort(cm)}
                </td>
                <td className="py-1 px-2 text-right tabular-nums text-gray-400">
                  {cohortSize.get(cm)}
                </td>
                {offsets.map(o => {
                  const p = cell.get(`${cm}|${o}`);
                  if (!p) {
                    // Cell not in the data — either the offset is in the
                    // future or snapshots predate the cohort+offset point.
                    return (
                      <td key={o} className="py-1 px-1">
                        <div className="h-7 rounded bg-gray-800/60 flex items-center justify-center text-gray-600">
                          —
                        </div>
                      </td>
                    );
                  }
                  return (
                    <td key={o} className="py-1 px-1">
                      <div
                        className={`h-7 rounded flex items-center justify-center text-white font-semibold tabular-nums ${bucketColour(p.retention_pct)}`}
                        title={`${p.active_count}/${p.cohort_size} retained`}
                      >
                        {p.retention_pct}%
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-gray-500 leading-relaxed">
        Reads from the daily <code className="font-mono text-gray-400">subscription_snapshots</code> table.
        Curves fill in over time — at first the snapshots-based view only
        has M0; each subsequent day adds one column of fidelity to all live
        cohorts. Empty cells mean either the offset hasn&rsquo;t elapsed yet,
        or snapshots predate the cohort+offset point.
      </p>
    </div>
  );
}

// ─── Cashback ROI section ───────────────────────────────────────────────────

/// Tiles + a small breakdown for the cashback program. Redemption rate is
/// INR-weighted (not count-weighted) because cashback amounts vary by plan
/// — a count rate would treat a ₹30 grant the same as a ₹500 one.
function CashbackRoiSection({ roi }: { roi: CashbackRoi }) {
  const noActivity = roi.granted_count === 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Cashback ROI</h2>
        <span className="text-xs text-gray-500">All-time, INR-weighted redemption</span>
      </div>

      {noActivity ? (
        <p className="text-sm text-gray-500 text-center py-8">No cashback grants yet.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <Tile
              label="Granted"
              value={formatInrCompact(roi.granted_inr)}
              hint={`${roi.granted_count} grants`}
              accent="gray"
            />
            <Tile
              label="Redeemed"
              value={formatInrCompact(roi.redeemed_inr)}
              hint={`${roi.redeemed_count} grants`}
              accent="green"
            />
            <Tile
              label="Pending"
              value={formatInrCompact(roi.pending_inr)}
              hint={`${roi.pending_count} grants`}
              accent="blue"
            />
            <Tile
              label="Expired"
              value={formatInrCompact(roi.expired_inr)}
              hint={`${roi.expired_count} grants`}
              accent="gray"
            />
          </div>

          {/* Redemption rate as a horizontal stacked bar. Visual cue beats
              digits for "what fraction of granted INR actually got
              redeemed". Three segments: redeemed (green), pending (blue),
              expired (gray). */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-xs text-gray-400">Redemption rate (INR-weighted)</span>
              <span className="text-xs font-semibold text-white tabular-nums">{roi.redemption_pct}%</span>
            </div>
            <div className="flex h-2 rounded-full overflow-hidden bg-gray-800">
              {(() => {
                const total = Math.max(1, roi.granted_inr);
                const seg = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
                return (
                  <>
                    <div className="bg-green-500" style={{ width: seg(roi.redeemed_inr) }} />
                    <div className="bg-blue-500"  style={{ width: seg(roi.pending_inr)  }} />
                    <div className="bg-gray-600"  style={{ width: seg(roi.expired_inr)  }} />
                  </>
                );
              })()}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-500">
              <span><span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1" />Redeemed</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-blue-500 mr-1"  />Pending</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-gray-600 mr-1"  />Expired</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/// Top-level operator analytics page. Phase 2.1.
///
/// Wrapped in `<AdminSecretGate>` so a customer who somehow reaches this URL
/// sees the gate prompt, not data. The actual data fetch always passes the
/// secret to the server; the gate is purely UX.
export default function InsightsPage() {
  return (
    <AdminSecretGate>
      <InsightsBody />
    </AdminSecretGate>
  );
}

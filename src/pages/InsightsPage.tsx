import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  LineChart, Line, CartesianGrid,
  AreaChart, Area, Legend,
} from 'recharts';
import { TrendingUp, Loader2, AlertCircle, RefreshCw, Download } from 'lucide-react';
import AdminSecretGate, { useAdminSecret } from '../components/AdminSecretGate';
import { toCsv, downloadCsv, dateStampForCsv } from '../lib/csv';

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

/// One day's reconstructed MRR + sub counts. Phase 2.4.
interface MrrHistoryRow {
  day:                string;     // YYYY-MM-DD
  mrr_inr:            number;
  paid_active_subs:   number;
  trial_active_subs:  number;
}

/// One day × plan slice of the MRR history. Phase 2.5. Long format on
/// the wire; the dashboard pivots wide for the stacked area chart so the
/// plan list stays dynamic.
interface MrrByPlanRow {
  day:               string;      // YYYY-MM-DD
  plan:              string;
  mrr_inr:           number;
  paid_active_subs:  number;
}

interface FunnelRow {
  plan:            string;     // '__overall__' for the topline aggregate
  signed_up:       number;
  trial_completed: number;
  paid_ever:       number;
  paid_now:        number;
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
  conversion_funnel:           FunnelRow[];
  cashback_roi:                CashbackRoi;
  cohort_retention_curves:     CurvePoint[];
  /// ISO timestamp of the last `REFRESH MATERIALIZED VIEW`. null when the
  /// materialized view has no rows yet. Surfaced as a "Cohort data as of X"
  /// subtitle on the heatmap so the operator sees freshness honestly,
  /// distinct from `generated_at` (wall-clock of the API call).
  cohort_data_materialized_at: string | null;
  /// Phase 2.4 — daily MRR series (90 days), reconstructed from the
  /// snapshot trail. See MrrHistorySection below.
  mrr_history:                 MrrHistoryRow[];
  /// REFRESH timestamp for the MRR-history materialized view. Distinct
  /// from cohort_data_materialized_at — the two MVs refresh on different
  /// crons (00:30 and 00:35 UTC).
  mrr_history_materialized_at: string | null;
  /// Phase 2.5 — per-plan daily MRR slices for the stacked area chart.
  /// Long format; the dashboard pivots wide.
  mrr_history_by_plan:         MrrByPlanRow[];
  mrr_history_by_plan_materialized_at: string | null;
  generated_at:                string;
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

// ─── CSV export button ──────────────────────────────────────────────────────

interface CsvButtonProps {
  /// Pre-built CSV string. Computed lazily by the caller (small data —
  /// no need for a builder thunk).
  csv:      string;
  filename: string;
  /// Hide when the source data is empty so the operator doesn't get a
  /// download with just a header row.
  disabled?: boolean;
}

/// Small "Download CSV" button rendered next to dashboard table headings.
/// Visually muted by default — the dashboard is a primary surface, the
/// download is a secondary affordance for ops handing data to finance /
/// putting in a deck. Phase 2.x cleanup.
function CsvButton({ csv, filename, disabled }: CsvButtonProps) {
  return (
    <button
      onClick={() => downloadCsv(filename, csv)}
      disabled={disabled || csv.length === 0}
      title={disabled || csv.length === 0 ? 'No data to export' : `Download ${filename}`}
      className="flex items-center gap-1 px-2 py-1 text-[11px] text-gray-500 hover:text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed border border-gray-800 rounded-md hover:border-gray-700 transition-colors"
    >
      <Download size={11} />
      CSV
    </button>
  );
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

      {/* ── MRR over time (Phase 2.4) ─────────────────────────────────── */}
      <MrrHistorySection
        rows={data.mrr_history}
        generatedAt={data.generated_at}
        materializedAt={data.mrr_history_materialized_at}
      />

      {/* ── MRR composition over time (Phase 2.5) ─────────────────────── */}
      <MrrCompositionSection
        rows={data.mrr_history_by_plan}
        generatedAt={data.generated_at}
        materializedAt={data.mrr_history_by_plan_materialized_at}
      />

      {/* Plan distribution */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-white">Plan distribution</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Active subscriptions per plan</span>
            <CsvButton
              csv={toCsv(
                data.plan_distribution.map(r => ({
                  plan:         r.plan,
                  active_count: r.active_count,
                  trial_count:  r.trial_count,
                  mrr_inr:      r.mrr_inr,
                })),
                ['plan', 'active_count', 'trial_count', 'mrr_inr'],
              )}
              filename={`plan-distribution-${dateStampForCsv(data.generated_at)}.csv`}
              disabled={data.plan_distribution.length === 0}
            />
          </div>
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
      <ConversionFunnelSection
        rows={data.conversion_funnel}
        generatedAt={data.generated_at}
      />

      {/* ── Cohort retention heatmap (Phase 2.3) ─────────────────────────── */}
      {/* Replaces the Phase 2.2 single-point cohort table. The new view
          reads from subscription_snapshots so we get historical M0/M1/...
          retention rather than just "active right now". Curves fill in
          over time — older cohorts have more columns populated, newer
          cohorts only have M0 for now. */}
      <CohortHeatmapSection
        points={data.cohort_retention_curves}
        generatedAt={data.generated_at}
        materializedAt={data.cohort_data_materialized_at}
      />

      {/* ── Cashback ROI (Phase 2.2) ─────────────────────────────────────── */}
      <CashbackRoiSection roi={data.cashback_roi} />
    </div>
  );
}

// ─── MRR over time section (Phase 2.4) ──────────────────────────────────────

/// 90-day MRR line chart. Reads from the `analytics_mrr_history` materialized
/// view (refreshed nightly), so the operator sees a "data as of X" stamp
/// alongside the API call's `generated_at` — same honesty pattern as the
/// cohort heatmap.
///
/// CSV export uses the standard `<CsvButton />`. Wide format isn't useful
/// here (single time-series), so the natural shape is one row per day.
function MrrHistorySection({
  rows,
  generatedAt,
  materializedAt,
}: {
  rows:           MrrHistoryRow[];
  generatedAt:    string;
  /// REFRESH time of the materialized view. null when the view is empty.
  materializedAt: string | null;
}) {
  const csv = toCsv(
    rows.map(r => ({
      day:                r.day,
      mrr_inr:            r.mrr_inr,
      paid_active_subs:   r.paid_active_subs,
      trial_active_subs:  r.trial_active_subs,
    })),
    ['day', 'mrr_inr', 'paid_active_subs', 'trial_active_subs'],
  );

  // Honest data-freshness stamp on the subtitle. Same pattern as the
  // cohort heatmap (see CohortHeatmapSection).
  const asOf = materializedAt
    ? new Date(materializedAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  // Has-any-MRR check: rows can exist (zero-filled days from the view) but
  // all be 0. We render the chart even then — a flat-zero line is the
  // honest answer "no paid subs yet" — but skip the chart entirely when
  // the array itself is empty (very fresh DB, no snapshots).
  const hasData = rows.length > 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">MRR over time</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            Last 90 days · daily series from snapshots
            {asOf && (
              <>
                {' · '}
                <span title="When the materialized view was last refreshed (daily by cron)">
                  data as of {asOf}
                </span>
              </>
            )}
          </span>
          <CsvButton
            csv={csv}
            filename={`mrr-history-${dateStampForCsv(generatedAt)}.csv`}
            disabled={!hasData}
          />
        </div>
      </div>

      {!hasData ? (
        <p className="text-sm text-gray-500 text-center py-8">
          No MRR history yet — snapshots are still being collected.
        </p>
      ) : (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="#1f2937" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDayShort}
                stroke="#6b7280"
                fontSize={11}
                interval="preserveStartEnd"
                minTickGap={32}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={11}
                tickFormatter={(v: number) => formatInrCompact(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0b0f19',
                  border:          '1px solid #1f2937',
                  borderRadius:    '0.5rem',
                  fontSize:        12,
                }}
                labelFormatter={formatDayShort}
                formatter={(value: number, name: string) => {
                  if (name === 'mrr_inr')          return [formatInr(value), 'MRR'];
                  if (name === 'paid_active_subs') return [value, 'Paid subs'];
                  return [value, name];
                }}
              />
              <Line
                type="monotone"
                dataKey="mrr_inr"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── MRR composition over time section (Phase 2.5) ──────────────────────────

/// Per-plan colour bands for the stacked area chart. Mirrors the pricing-grid
/// + StatusBadge palette from AdminPage so an operator scanning the chart
/// reads "blue = essential" with no key-lookup gymnastics. Falls back to a
/// neutral gray for unrecognised plan names (legacy rows, future plans
/// added before the dashboard learns about them).
const PLAN_COLOUR: Record<string, string> = {
  trial:        '#6b7280', // gray-500
  essential:    '#3b82f6', // blue-500
  professional: '#14b8a6', // teal-500
  business:     '#a855f7', // purple-500
  enterprise:   '#eab308', // yellow-500
};
const PLAN_COLOUR_FALLBACK = '#4b5563'; // gray-600

/// Stacked area chart showing per-plan MRR over the last 90 days. Pivots
/// long-format API rows into wide format for Recharts (one row per day,
/// one column per plan). Plan list is derived from the data so adding a
/// new plan_definitions row doesn't need a code change.
function MrrCompositionSection({
  rows,
  generatedAt,
  materializedAt,
}: {
  rows:           MrrByPlanRow[];
  generatedAt:    string;
  materializedAt: string | null;
}) {
  // Pivot long → wide. Keys are plan names; values are MRR contributions
  // for that day. Recharts reads this directly; one <Area> per plan.
  type WideRow = { day: string; [plan: string]: number | string };
  const dayMap = new Map<string, WideRow>();
  const planSet = new Set<string>();
  for (const r of rows) {
    planSet.add(r.plan);
    let day = dayMap.get(r.day);
    if (!day) {
      day = { day: r.day };
      dayMap.set(r.day, day);
    }
    day[r.plan] = r.mrr_inr;
  }

  // Stable plan ordering for stacked bands. Largest contributor at the
  // bottom → keeps the dominant band visually anchored as the chart
  // shifts. Ties broken alphabetically for determinism.
  const totalsByPlan = new Map<string, number>();
  for (const r of rows) {
    totalsByPlan.set(r.plan, (totalsByPlan.get(r.plan) ?? 0) + r.mrr_inr);
  }
  const plans = Array.from(planSet).sort((a, b) => {
    const diff = (totalsByPlan.get(b) ?? 0) - (totalsByPlan.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  // Recharts wants the days sorted ascending.
  const wideRows: WideRow[] = Array.from(dayMap.values()).sort((a, b) =>
    String(a.day).localeCompare(String(b.day)),
  );

  // Fill missing plan-cells with 0 so the stack doesn't jitter when a
  // plan goes from "had MRR" to "no MRR" mid-window.
  for (const row of wideRows) {
    for (const plan of plans) {
      if (typeof row[plan] !== 'number') row[plan] = 0;
    }
  }

  // CSV export uses the long format from the API directly — natural
  // shape for a finance pivot, doesn't lock the consumer into the wide
  // schema we picked for the chart.
  const csv = toCsv(
    rows.map(r => ({
      day:              r.day,
      plan:             r.plan,
      mrr_inr:          r.mrr_inr,
      paid_active_subs: r.paid_active_subs,
    })),
    ['day', 'plan', 'mrr_inr', 'paid_active_subs'],
  );

  const asOf = materializedAt
    ? new Date(materializedAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  const hasData = wideRows.length > 0 && plans.length > 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">MRR composition</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            Last 90 days · per-plan, stacked
            {asOf && (
              <>
                {' · '}
                <span title="When the materialized view was last refreshed (daily by cron)">
                  data as of {asOf}
                </span>
              </>
            )}
          </span>
          <CsvButton
            csv={csv}
            filename={`mrr-composition-${dateStampForCsv(generatedAt)}.csv`}
            disabled={!hasData}
          />
        </div>
      </div>

      {!hasData ? (
        <p className="text-sm text-gray-500 text-center py-8">
          No per-plan MRR history yet — snapshots are still being collected.
        </p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={wideRows}
              margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
            >
              <CartesianGrid stroke="#1f2937" />
              <XAxis
                dataKey="day"
                tickFormatter={formatDayShort}
                stroke="#6b7280"
                fontSize={11}
                interval="preserveStartEnd"
                minTickGap={32}
              />
              <YAxis
                stroke="#6b7280"
                fontSize={11}
                tickFormatter={(v: number) => formatInrCompact(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#0b0f19',
                  border:          '1px solid #1f2937',
                  borderRadius:    '0.5rem',
                  fontSize:        12,
                }}
                labelFormatter={formatDayShort}
                formatter={(value: number, name: string) => [formatInr(value), name]}
              />
              <Legend
                wrapperStyle={{ fontSize: 11, color: '#9ca3af' }}
                iconType="square"
              />
              {plans.map(plan => (
                <Area
                  key={plan}
                  type="monotone"
                  dataKey={plan}
                  stackId="mrr"
                  // 0.85 alpha mixes adjacent bands enough that overlapping
                  // values stay readable; pure 1.0 looks like a hard
                  // billboard.
                  fillOpacity={0.85}
                  stroke={PLAN_COLOUR[plan] ?? PLAN_COLOUR_FALLBACK}
                  fill={PLAN_COLOUR[plan]   ?? PLAN_COLOUR_FALLBACK}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ─── Conversion funnel section ──────────────────────────────────────────────

/// Renders the topline 4-stage funnel as a horizontal bar series, plus a
/// per-plan numbers table beneath. Splits the synthetic '__overall__' row
/// from per-plan rows server-side so the chart never double-counts.
function ConversionFunnelSection({ rows, generatedAt }: { rows: FunnelRow[]; generatedAt: string }) {
  const overall  = rows.find(r => r.plan === '__overall__');
  const perPlan  = rows.filter(r => r.plan !== '__overall__');

  // Bar chart input — one bar per stage.
  const stages = overall ? [
    { stage: 'Signed up',       count: overall.signed_up },
    { stage: 'Trial completed', count: overall.trial_completed },
    { stage: 'Paid (ever)',     count: overall.paid_ever },
    { stage: 'Active now',      count: overall.paid_now },
  ] : [];

  // Long-format CSV: one row per (plan, stage). The synthetic '__overall__'
  // row is included verbatim so the export and the on-screen chart match
  // exactly — a flat consumer of the CSV gets the topline by filtering for
  // plan='__overall__'.
  const funnelCsv = toCsv(
    rows.map(r => ({
      plan:            r.plan,
      signed_up:       r.signed_up,
      trial_completed: r.trial_completed,
      paid_ever:       r.paid_ever,
      paid_now:        r.paid_now,
      conversion_pct:  r.signed_up > 0
        ? Math.round((r.paid_ever / r.signed_up) * 1000) / 10
        : 0,
    })),
    ['plan', 'signed_up', 'trial_completed', 'paid_ever', 'paid_now', 'conversion_pct'],
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">Conversion funnel</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">Last 90 days</span>
          <CsvButton
            csv={funnelCsv}
            filename={`conversion-funnel-${dateStampForCsv(generatedAt)}.csv`}
            disabled={rows.length === 0}
          />
        </div>
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
function CohortHeatmapSection({
  points,
  generatedAt,
  materializedAt,
}: {
  points:         CurvePoint[];
  generatedAt:    string;
  /// When the materialized view was last refreshed by the daily cron.
  /// Null while the view is empty (no paid cohorts yet).
  materializedAt: string | null;
}) {
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

  // Wide-format CSV: one row per cohort with M0..M11 columns. Mirrors
  // what the operator sees on screen — easier to drop into a deck or
  // Excel pivot than the long format. Empty cells become empty strings,
  // not '0', so the data gap is preserved on export.
  const cohortCsv = toCsv(
    cohortMonths.map(cm => {
      const row: Record<string, unknown> = {
        cohort: cm.slice(0, 7),               // YYYY-MM
        size:   cohortSize.get(cm) ?? 0,
      };
      for (const o of offsets) {
        const p = cell.get(`${cm}|${o}`);
        row[`M${o}`] = p ? p.retention_pct : '';
      }
      return row;
    }),
    ['cohort', 'size', ...offsets.map(o => `M${o}`)],
  );

  // Honest freshness label. The view is materialized + refreshed daily by
  // pg_cron, so the data the operator's looking at can be up to ~24h stale —
  // distinct from the API call's `generated_at`. Format locally so an
  // operator in a non-IST timezone reads it in their own.
  const cohortAsOf = materializedAt
    ? new Date(materializedAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-white">Paid cohort retention</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            Last 12 months · M0–M11 from snapshots
            {cohortAsOf && (
              <>
                {' · '}
                <span title="When the materialized view was last refreshed (daily by cron)">
                  data as of {cohortAsOf}
                </span>
              </>
            )}
          </span>
          <CsvButton
            csv={cohortCsv}
            filename={`cohort-retention-${dateStampForCsv(generatedAt)}.csv`}
          />
        </div>
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
        Reads from the daily <code className="font-mono text-gray-400">subscription_snapshots</code> table
        via a materialized view refreshed nightly. Curves fill in over time —
        at first only M0 has data; each subsequent day adds one column of
        fidelity to all live cohorts. Empty cells mean either the offset
        hasn&rsquo;t elapsed yet, or snapshots predate the cohort+offset point.
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

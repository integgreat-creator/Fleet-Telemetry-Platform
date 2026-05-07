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

/// One bucket of the cancellation-reasons aggregate. Phase 3.10.
/// `reason` is one of the canonical enum values from RECOGNISED_REASONS
/// (see razorpay-cancel-subscription); `pct` is share-of-cancellations
/// already rounded to 2 decimals server-side so the dashboard can render
/// bars without recomputing.
interface CancellationReasonRow {
  reason: string;
  count:  number;
  pct:    number;
}

/// Recent free-text cancellation comment. The buckets tell ops what; the
/// comments tell them why. Capped at 280 chars on the wire.
interface CancellationCommentRow {
  requested_at: string;
  reason:       string;
  comment:      string;
}

/// One failed-payment row for the operator dunning surface. Phase 3.9.
/// The audit log is the source of truth — analytics-api decorates each
/// row with the joined fleet name, manager email, current sub status,
/// and a derived days_since_failed for at-a-glance triage.
interface FailedPaymentRow {
  audit_id:           string;
  fleet_id:           string | null;
  fleet_name:         string | null;
  /// May be null if the manager_id is missing or auth.users lookup fails.
  manager_email:      string | null;
  amount_inr:         number;
  currency:           string;
  error_code:         string | null;
  error_description:  string | null;
  error_reason:       string | null;
  payment_id:         string | null;
  failed_at:          string;
  /// Subscription status NOW. 'suspended' = still dunning. 'active' =
  /// recovered after a retry. Other values are corner cases (the customer
  /// cancelled / paused while dunning) — the dashboard styles them as
  /// "resolved" so ops don't waste outreach on them.
  current_status:     string | null;
  days_since_failed:  number;
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
  /// Phase 3.9 — last 30 days of payment.failed audit rows enriched with
  /// fleet + manager info + current sub status. Sorted newest-first.
  failed_payments:             FailedPaymentRow[];
  /// Phase 3.10 — 90-day cancellation-reasons aggregate + recent free-text
  /// comments. Empty arrays for fresh installs / quiet windows.
  cancellation_reasons:        CancellationReasonRow[];
  cancellation_recent_comments: CancellationCommentRow[];
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

// ─── MoM delta computation (Phase 3.13) ────────────────────────────────────

/// Compute month-over-month deltas for the topline tiles from the daily
/// MRR-history series. Returns `null` when the dataset is too thin or
/// has insufficient signal for a meaningful baseline; callers render a
/// muted placeholder in that case.
///
/// We compare the last row (today) with the 31st-from-last row (~30 days
/// ago). The series is materialized + zero-filled, so when there's any
/// data at all the row count == days-since-MRR-history-began. We require
/// at least 30 rows to even attempt the comparison; below that, the
/// "month ago" baseline isn't a full month behind.
///
/// Prior-zero baselines deliberately resolve to null, not Infinity. A
/// jump from ₹0 → ₹50,000 is real but "+∞%" tells nobody anything; the
/// raw value is already on the tile for that signal.
function computeMomDeltas(
  rows: ReadonlyArray<MrrHistoryRow>,
): { mrr: TileDelta | null; paidSubs: TileDelta | null } | null {
  if (rows.length < 30) return null;
  const last  = rows[rows.length - 1];
  const prior = rows[rows.length - 31];
  if (!last || !prior) return null;

  const mrrDelta: TileDelta | null = prior.mrr_inr > 0
    ? { pct: ((last.mrr_inr - prior.mrr_inr) / prior.mrr_inr) * 100 }
    : null;

  const paidDelta: TileDelta | null = prior.paid_active_subs > 0
    ? { pct: ((last.paid_active_subs - prior.paid_active_subs) / prior.paid_active_subs) * 100 }
    : null;

  return { mrr: mrrDelta, paidSubs: paidDelta };
}

// ─── Tiles ───────────────────────────────────────────────────────────────────

/// MoM delta payload for a tile. `null` means "no baseline" — typically the
/// dataset doesn't have ≥30 days of history yet (fresh install) or the
/// prior value was zero (first paying customer just landed). The Tile
/// renders nothing in that case rather than printing a misleading "+∞%".
///
/// `positiveIsGood` controls colour direction. All current topline metrics
/// are positive=good; the prop exists for future tiles where it isn't
/// (e.g. churn rate, where +X% is bad). Default true.
interface TileDelta {
  pct:             number;
  positiveIsGood?: boolean;
}

interface TileProps {
  label:    string;
  value:    string;
  hint?:    string;
  accent?:  'blue' | 'green' | 'gray';
  /// Phase 3.13. Optional MoM delta line under the value. `undefined`
  /// hides the line entirely (used for tiles where MoM isn't meaningful);
  /// `null` reserves the slot but renders a muted "—" placeholder so tiles
  /// in the same row stay vertically aligned.
  delta?:   TileDelta | null;
}

/// Format a MoM percentage to two-significant-digit precision with a sign.
/// Numbers above 1000% are clamped to "+999%"-style display — past that
/// point the actual value is misleading anyway (usually growth from a
/// near-zero baseline) and the unbounded number wrecks the tile width.
function formatMomPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  const mag  = Math.abs(pct);
  if (mag >= 999) return `${sign}999%`;
  if (mag >= 10)  return `${sign}${mag.toFixed(0)}%`;
  return `${sign}${mag.toFixed(1)}%`;
}

function Tile({ label, value, hint, accent = 'gray', delta }: TileProps) {
  const accentClasses = {
    blue:  'border-blue-900/60  bg-blue-950/20',
    green: 'border-green-900/60 bg-green-950/20',
    gray:  'border-gray-800     bg-gray-900',
  }[accent];

  // Resolve delta colour. We treat ≤ 0.5% changes as "flat" because
  // everything inside that band is noise from rounding / cron timing
  // rather than a genuine MoM trend signal.
  let deltaNode: React.ReactNode = null;
  if (delta === null) {
    deltaNode = <span className="text-gray-600">— vs last month</span>;
  } else if (delta && Number.isFinite(delta.pct)) {
    const positiveIsGood = delta.positiveIsGood !== false;
    const flat   = Math.abs(delta.pct) < 0.5;
    const colour = flat
      ? 'text-gray-500'
      : (delta.pct > 0) === positiveIsGood
        ? 'text-emerald-400'
        : 'text-red-400';
    deltaNode = (
      <span className={`${colour} font-medium`}>
        {formatMomPct(delta.pct)} <span className="text-gray-500 font-normal">vs last month</span>
      </span>
    );
  }

  return (
    <div className={`rounded-xl border ${accentClasses} p-5 space-y-1`}>
      <p className="text-[10px] uppercase tracking-widest text-gray-500 font-semibold">{label}</p>
      <p className="text-2xl font-bold text-white tabular-nums">{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
      {deltaNode !== null && <p className="text-[11px]">{deltaNode}</p>}
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

  // ── MoM deltas (Phase 3.13) ────────────────────────────────────────────
  // mrr_history is sorted ascending by day and zero-filled by the
  // materialized view, so a 90-day series always has 90 rows once the MV
  // has been refreshed at least once after the system has been live for
  // 90 days. Before that, we may have <30 rows of meaningful data —
  // computeMomDelta returns null for that case and the tiles render a
  // muted placeholder so the layout stays stable.
  //
  // We compare today (last row) vs ~30 days ago (31st-from-last row).
  // Using calendar months would mean different denominators (28 vs 31
  // days) and a cohort split — over a 90-day moving window, fixed-30-day
  // MoM is the conventional SaaS metric.
  const momDeltas = computeMomDeltas(data.mrr_history);

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
          delta={momDeltas?.mrr ?? null}
        />
        <Tile
          label="ARR"
          value={formatInrCompact(data.arr_inr)}
          hint={formatInr(data.arr_inr)}
          accent="blue"
          /* ARR = MRR × 12 → identical pct delta. Showing it on both
             tiles makes the row consistent rather than printing a
             baffling "—" on the tile that's algebraically the same. */
          delta={momDeltas?.mrr ?? null}
        />
        <Tile
          label="Paid active subs"
          value={String(data.paid_active_subs)}
          hint={`${data.trial_active_subs} on trial`}
          delta={momDeltas?.paidSubs ?? null}
        />
        <Tile
          label="New paid (30d)"
          value={String(totalNewSubs30d)}
          hint="status flipped to active"
          /* Deliberately no delta: the tile is itself a 30-day window,
             a MoM-vs-prior-30-day comparison would need 60 days of
             daily data which isn't in the API response. Skipping
             beats fabricating. */
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

      {/* ── Cancellation reasons (Phase 3.10) ─────────────────────────────── */}
      {/* Why customers leave. Bucket bars + recent free-text comments.
          Sits just below ROI/funnel because it's the natural counterpart
          — the funnel says how many we lost, this says why. Hidden when
          there's nothing to show. */}
      <CancellationReasonsSection
        rows={data.cancellation_reasons}
        comments={data.cancellation_recent_comments}
        generatedAt={data.generated_at}
      />

      {/* ── Failed-payment dunning surface (Phase 3.9) ───────────────────── */}
      {/* Sits below the analytics views but above operator utilities — it's
          actionable insight rather than passive metrics, so it deserves
          prime placement. Hidden when there are zero failures in the
          window so a healthy steady state shows nothing rather than an
          empty table. */}
      <FailedPaymentsSection rows={data.failed_payments} generatedAt={data.generated_at} />

      {/* ── Operator manual cashback grant (Phase 3.6) ───────────────────── */}
      {/* Lowest-priority section — utility for support, not insight. Sits
          at the bottom so analytics still anchors the page. */}
      <ManualCashbackGrantSection onGranted={refresh} />
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

// ─── Cancellation reasons section (Phase 3.10) ────────────────────────────

/// Reason labels for the dashboard. Mirrors the enum in
/// razorpay-cancel-subscription (RECOGNISED_REASONS). The 'other' bucket is
/// always last in display order so ops eyes land on the actionable signal
/// (too_expensive, missing_features, switching_competitor) first.
const REASON_LABELS: Record<string, string> = {
  too_expensive:        'Too expensive',
  missing_features:     'Missing features',
  switching_competitor: 'Switching competitor',
  temporary_pause:      'Temporary pause',
  just_exploring:       'Just exploring',
  other:                'Other',
};

/// Per-bucket bar tint. We avoid a single colour ramp because reasons
/// aren't ordinal — too_expensive is not "more severe" than
/// missing_features. Using distinct hues makes the stacked bar legible at
/// a glance. Falls back to gray for unrecognised reasons (server-side
/// normalisation should prevent this but the dashboard handles it
/// gracefully anyway).
const REASON_COLOR: Record<string, string> = {
  too_expensive:        'bg-red-500',
  missing_features:     'bg-orange-500',
  switching_competitor: 'bg-yellow-500',
  temporary_pause:      'bg-blue-500',
  just_exploring:       'bg-purple-500',
  other:                'bg-gray-500',
};

function reasonLabel(key: string): string {
  return REASON_LABELS[key] ?? key.replace(/_/g, ' ');
}

function CancellationReasonsSection({
  rows,
  comments,
  generatedAt,
}: {
  rows:        CancellationReasonRow[];
  comments:    CancellationCommentRow[];
  generatedAt: string;
}) {
  // Hide entirely when there's nothing in the window. Same pattern as the
  // failed-payments card — no point in a "0 cancellations" empty state on
  // a fresh install.
  if (rows.length === 0 && comments.length === 0) return null;

  const total = rows.reduce((sum, r) => sum + r.count, 0);

  // Sort consistently for the bar + table: highest-count first, 'other'
  // always last. Server already orders by count DESC, but normalise here
  // so the rules are explicit at the render site.
  const sortedRows = [...rows].sort((a, b) => {
    if (a.reason === 'other') return 1;
    if (b.reason === 'other') return -1;
    return b.count - a.count;
  });

  const csv = toCsv(
    sortedRows.map(r => ({
      reason: reasonLabel(r.reason),
      count:  r.count,
      pct:    r.pct,
    })),
    ['reason', 'count', 'pct'],
  );

  return (
    <div className="bg-gray-900 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Cancellation reasons</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Last 90 days · {total} {total === 1 ? 'cancellation' : 'cancellations'}
          </p>
        </div>
        <CsvButton
          csv={csv}
          filename={`cancellation-reasons-${dateStampForCsv(generatedAt)}.csv`}
          disabled={rows.length === 0}
        />
      </div>

      {rows.length > 0 && (
        <>
          {/* Stacked horizontal bar — at-a-glance distribution. Each
              segment is sized by pct, no labels inline (would crowd at
              small bucket counts); the table below carries the numbers. */}
          <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-800 mb-3">
            {sortedRows.map(r => (
              <div
                key={r.reason}
                className={REASON_COLOR[r.reason] ?? 'bg-gray-500'}
                style={{ width: `${r.pct}%` }}
                title={`${reasonLabel(r.reason)}: ${r.count} (${r.pct}%)`}
              />
            ))}
          </div>

          {/* Per-bucket rows: dot + label + count + share. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {sortedRows.map(r => (
              <div key={r.reason} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${REASON_COLOR[r.reason] ?? 'bg-gray-500'}`} />
                  <span className="text-gray-300 truncate">{reasonLabel(r.reason)}</span>
                </div>
                <div className="text-gray-400 tabular-nums whitespace-nowrap">
                  <span className="text-white">{r.count}</span>
                  <span className="text-gray-500 text-xs ml-1.5">({r.pct}%)</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Recent free-text comments — qualitative signal alongside the
          quantitative buckets. Only render the section when at least one
          customer left a non-empty comment in the window. */}
      {comments.length > 0 && (
        <div className="mt-5 pt-4 border-t border-gray-800">
          <h3 className="text-[11px] uppercase tracking-wide text-gray-500 font-medium mb-3">
            Recent comments
          </h3>
          <div className="space-y-2.5">
            {comments.map(c => (
              <div key={c.requested_at + c.comment.slice(0, 16)} className="text-sm">
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-0.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${REASON_COLOR[c.reason] ?? 'bg-gray-500'}`} />
                  <span>{reasonLabel(c.reason)}</span>
                  <span className="text-gray-600">·</span>
                  <span>{formatDayShort(c.requested_at)}</span>
                </div>
                <blockquote className="text-gray-300 leading-relaxed pl-3 border-l-2 border-gray-700">
                  {c.comment}
                </blockquote>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Failed-payment dunning section (Phase 3.9) ───────────────────────────

/// Operator triage view: a table of every payment.failed event in the last
/// 30 days, joined with fleet name, manager email, error reason, and the
/// current subscription status.
///
/// `current_status === 'suspended'` is the actionable cohort — those are
/// fleets where the card failed and we haven't recovered yet. Rows where
/// status flipped back to 'active' (Razorpay's auto-retry succeeded, or the
/// customer updated their card) are styled muted as "Recovered" so ops
/// don't waste outreach. Other statuses (paused/inactive/cancelled) mean
/// the customer moved on under their own steam — also muted.
///
/// CSV export uses the same toCsv/CsvButton primitives as the other
/// sections — operators routinely paste these into a Google Sheet to
/// distribute outreach across the support team.
function FailedPaymentsSection({
  rows,
  generatedAt,
}: {
  rows:        FailedPaymentRow[];
  generatedAt: string;
}) {
  // Empty-state: no failures in the lookback window. Hide the whole card —
  // a healthy steady state should not push noise onto the dashboard.
  if (rows.length === 0) return null;

  const stillSuspended = rows.filter(r => r.current_status === 'suspended').length;
  const recovered      = rows.length - stillSuspended;

  // toCsv takes plain row objects keyed by column names — flatten the
  // FailedPaymentRow into a CSV-friendly shape with stable, human-readable
  // headers. Operators paste these into a Google Sheet to divvy up
  // outreach, so column order matters: time + fleet + contact first,
  // amount + reason next, status + payment_id at the end.
  const csv = toCsv(
    rows.map(r => ({
      failed_at:          r.failed_at,
      days_since:         r.days_since_failed,
      fleet:              r.fleet_name ?? r.fleet_id ?? '',
      manager_email:      r.manager_email ?? '',
      amount_inr:         r.amount_inr,
      error_code:         r.error_code        ?? '',
      error_description:  r.error_description ?? '',
      current_status:     r.current_status    ?? '',
      payment_id:         r.payment_id        ?? '',
    })),
    [
      'failed_at', 'days_since', 'fleet', 'manager_email', 'amount_inr',
      'error_code', 'error_description', 'current_status', 'payment_id',
    ],
  );

  return (
    <div className="bg-gray-900 rounded-xl p-5">
      <div className="flex items-start justify-between mb-4 gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <AlertCircle size={14} className="text-red-400" />
            Recent payment failures
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Last 30 days · {stillSuspended} still suspended · {recovered} recovered
          </p>
        </div>
        <CsvButton
          csv={csv}
          filename={`failed-payments-${dateStampForCsv(generatedAt)}.csv`}
        />
      </div>

      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-800">
              <th className="font-medium pb-2 pr-3">Failed</th>
              <th className="font-medium pb-2 pr-3">Fleet</th>
              <th className="font-medium pb-2 pr-3">Contact</th>
              <th className="font-medium pb-2 pr-3 text-right">Amount</th>
              <th className="font-medium pb-2 pr-3">Reason</th>
              <th className="font-medium pb-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rows.map(r => {
              const muted = r.current_status !== 'suspended';
              return (
                <tr key={r.audit_id} className={muted ? 'opacity-60' : ''}>
                  <td className="py-2.5 pr-3 text-gray-300 whitespace-nowrap">
                    <div>{formatDayShort(r.failed_at)}</div>
                    <div className="text-[11px] text-gray-500">
                      {r.days_since_failed === 0
                        ? 'today'
                        : r.days_since_failed === 1
                          ? '1 day ago'
                          : `${r.days_since_failed} days ago`}
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-gray-200">
                    {r.fleet_name || <span className="text-gray-500 font-mono text-xs">{r.fleet_id ?? '—'}</span>}
                  </td>
                  <td className="py-2.5 pr-3 text-gray-300">
                    {r.manager_email ? (
                      <a
                        href={`mailto:${r.manager_email}?subject=Payment%20failure%20on%20your%20FTPGo%20subscription`}
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        {r.manager_email}
                      </a>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3 text-gray-200 text-right font-mono whitespace-nowrap">
                    {formatInr(r.amount_inr)}
                  </td>
                  <td className="py-2.5 pr-3 text-gray-300">
                    <div className="font-medium">{r.error_code ?? <span className="text-gray-600">—</span>}</div>
                    {r.error_description && (
                      <div className="text-[11px] text-gray-500 max-w-[24ch] truncate" title={r.error_description}>
                        {r.error_description}
                      </div>
                    )}
                  </td>
                  <td className="py-2.5">
                    <FailureStatusBadge status={r.current_status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/// Tiny status pill. Suspended is the only "act now" state — everything
/// else is informational, so we mute the colors. Trial isn't reachable
/// from a payment.failed event but we render it gracefully if it ever
/// shows up (e.g. customer downgraded back to trial after a failure).
function FailureStatusBadge({ status }: { status: string | null }) {
  if (status === 'suspended') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 text-[10px] font-semibold uppercase tracking-wide">
        Suspended
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-green-900/40 text-green-400 text-[10px] font-semibold uppercase tracking-wide">
        Recovered
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 text-[10px] font-semibold uppercase tracking-wide">
      {status ?? '—'}
    </span>
  );
}

// ─── Manual cashback grant section (Phase 3.6) ─────────────────────────────

/// Operator-only utility for issuing a cashback credit to a specific fleet —
/// support compensation, makegood, etc. Calls admin-grant-cashback (which
/// validates + audit-logs + inserts into fleet_credits).
///
/// Visible at the bottom of the dashboard because it's a tool, not insight.
/// AdminSecretGate has already authenticated the operator; we read the
/// secret from sessionStorage via useAdminSecret to attach to the API call.
function ManualCashbackGrantSection({ onGranted }: { onGranted: () => void }) {
  const adminSecret = useAdminSecret();
  const [fleetId,        setFleetId]        = useState('');
  const [amountInr,      setAmountInr]      = useState('');
  const [reason,         setReason]         = useState('manual_makegood');
  const [expiresInDays,  setExpiresInDays]  = useState('90');
  const [comment,        setComment]        = useState('');
  const [submitting,     setSubmitting]     = useState(false);
  const [result,         setResult]         = useState<{ kind: 'ok'; amount: number; expires_at: string } | { kind: 'err'; msg: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || !adminSecret) return;
    setSubmitting(true);
    setResult(null);
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-grant-cashback`;
      const res = await fetch(url, {
        method:  'POST',
        headers: {
          'X-Admin-Secret': adminSecret,
          'apikey':         import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Authorization':  `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          'Content-Type':   'application/json',
        },
        body: JSON.stringify({
          fleet_id:        fleetId.trim(),
          amount_inr:      Number(amountInr),
          reason:          reason.trim(),
          expires_in_days: Number(expiresInDays),
          comment:         comment.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json();
      setResult({
        kind:       'ok',
        amount:     Number(body.amount_inr),
        expires_at: String(body.expires_at),
      });
      // Reset the form on success so the operator doesn't accidentally
      // re-submit the same grant. Keep the reason field — it's likely
      // the same across consecutive grants in a support session.
      setFleetId('');
      setAmountInr('');
      setExpiresInDays('90');
      setComment('');
      // Refresh the dashboard so the granted credit shows up in the
      // cashback ROI tiles immediately.
      onGranted();
    } catch (e) {
      setResult({ kind: 'err', msg: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-sm font-semibold text-white">Manual cashback grant</h2>
        <span className="text-xs text-gray-500">Operator utility · audit-logged</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Fleet ID (UUID)</label>
            <input
              type="text"
              value={fleetId}
              onChange={e => setFleetId(e.target.value)}
              required
              spellCheck={false}
              autoComplete="off"
              placeholder="00000000-0000-0000-0000-000000000000"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Amount (₹)</label>
            <input
              type="number"
              value={amountInr}
              onChange={e => setAmountInr(e.target.value)}
              required
              min="1"
              max="10000"
              placeholder="200"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Reason (≤ 64 chars)</label>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              required
              maxLength={64}
              placeholder="manual_makegood"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Expires in (days)</label>
            <input
              type="number"
              value={expiresInDays}
              onChange={e => setExpiresInDays(e.target.value)}
              required
              min="1"
              max="365"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">
            Comment <span className="text-gray-600">(optional, ≤ 500 chars)</span>
          </label>
          <textarea
            value={comment}
            onChange={e => setComment(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="What ticket / incident is this against?"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 resize-none"
          />
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-gray-500">
            The credit is auto-redeemed against the fleet's next paid charge.
            Manual grants don't replace the first-charge cashback — they stack.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors flex-shrink-0"
          >
            {submitting ? 'Granting…' : 'Grant credit'}
          </button>
        </div>

        {result?.kind === 'ok' && (
          <div className="flex gap-3 p-3 bg-emerald-950/40 border border-emerald-900/60 rounded-lg">
            <div className="text-xs text-emerald-200 leading-relaxed">
              ₹{result.amount.toLocaleString('en-IN')} credit granted, expires{' '}
              {new Date(result.expires_at).toLocaleDateString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric',
              })}.
            </div>
          </div>
        )}
        {result?.kind === 'err' && (
          <div className="flex gap-3 p-3 bg-red-950/40 border border-red-900/60 rounded-lg">
            <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
            <div className="text-xs text-red-200 leading-relaxed">{result.msg}</div>
          </div>
        )}
      </form>
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

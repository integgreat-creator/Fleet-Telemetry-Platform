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

interface SummaryResponse {
  mrr_inr:               number;
  arr_inr:               number;
  paid_active_subs:      number;
  trial_active_subs:     number;
  total_subs:            number;
  plan_distribution:     PlanDistRow[];
  new_paid_subs_daily:   DailyRow[];
  generated_at:          string;
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

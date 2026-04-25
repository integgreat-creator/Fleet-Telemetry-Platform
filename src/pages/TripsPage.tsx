import { useState, useEffect, useCallback } from 'react';
import {
  Route, Clock, Fuel, TrendingUp, TrendingDown, Car,
  AlertTriangle, DollarSign, X, Save, ChevronRight,
  BarChart2, IndianRupee,
} from 'lucide-react';
import { supabase, type Vehicle, type Trip } from '../lib/supabase';

const EDGE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trip-expense-api`;

const rupee = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);

interface TripWithExtras extends Trip {
  vehicle_name?: string;
  gap_count?: number;
  gap_duration_minutes?: number;
  data_confidence_score?: number | null;
  total_revenue?: number;
  total_expense?: number;
  profit?: number;
}

interface TripExpenses {
  fuel_cost: number;
  toll_cost: number;
  driver_allowance: number;
  maintenance_cost: number;
  other_cost: number;
  notes: string;
  _estimated?: boolean;
}

interface TripRevenue {
  amount: number;
  description: string;
  _estimated?: boolean;
}

interface DailySummary {
  date: string;
  trip_count: number;
  total_revenue: number;
  total_expense: number;
  net_profit: number;
  total_distance_km: number;
}

interface VehicleRanking {
  vehicle_id: string;
  vehicle_name: string;
  completed_trips: number;
  total_revenue: number;
  total_expense: number;
  net_profit: number;
  profit_margin_pct: number;
}

function ConfidenceBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-gray-600 text-xs">—</span>;
  if (score >= 80) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
      {score.toFixed(0)}% Good
    </span>
  );
  if (score >= 70) return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/20 text-yellow-400">
      {score.toFixed(0)}% Fair
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400">
      <AlertTriangle className="w-3 h-3" />
      {score.toFixed(0)}% Unreliable
    </span>
  );
}

function ProfitBadge({ profit }: { profit: number | undefined }) {
  if (profit == null) return <span className="text-gray-600 text-xs">—</span>;
  if (profit >= 0) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
      <TrendingUp className="w-3 h-3" />{rupee(profit)}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400">
      <TrendingDown className="w-3 h-3" />{rupee(profit)}
    </span>
  );
}

// ── Trip Detail / Edit Panel ──────────────────────────────────────────────────
function TripDetailPanel({
  trip,
  onClose,
  onSaved,
}: {
  trip: TripWithExtras;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [expenses, setExpenses] = useState<TripExpenses | null>(null);
  const [revenue, setRevenue]   = useState<TripRevenue | null>(null);
  const [loading, setLoading]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  // Editable fields
  const [amount, setAmount]           = useState('');
  const [description, setDescription] = useState('');
  const [toll, setToll]               = useState('');
  const [allowance, setAllowance]     = useState('');
  const [other, setOther]             = useState('');
  const [notes, setNotes]             = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${EDGE}?trip_id=${trip.id}`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error); setLoading(false); return; }
      setExpenses(body.expenses);
      setRevenue(body.revenue);
      setAmount(String(body.revenue?.amount ?? 0));
      setDescription(body.revenue?.description ?? '');
      setToll(String(body.expenses?.toll_cost ?? 0));
      setAllowance(String(body.expenses?.driver_allowance ?? 0));
      setOther(String(body.expenses?.other_cost ?? 0));
      setNotes(body.expenses?.notes ?? '');
      setLoading(false);
    })();
  }, [trip.id]);

  const totalExpense = (expenses?.fuel_cost ?? 0)
    + Number(toll || 0)
    + Number(allowance || 0)
    + (expenses?.maintenance_cost ?? 0)
    + Number(other || 0);
  const liveProfit = Number(amount || 0) - totalExpense;

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token}`,
      };
      const [expRes, revRes] = await Promise.all([
        fetch(EDGE, {
          method: 'POST', headers,
          body: JSON.stringify({
            action: 'upsert-expenses', trip_id: trip.id,
            toll_cost: Number(toll), driver_allowance: Number(allowance),
            other_cost: Number(other), notes,
          }),
        }),
        fetch(EDGE, {
          method: 'POST', headers,
          body: JSON.stringify({
            action: 'upsert-revenue', trip_id: trip.id,
            amount: Number(amount), description,
          }),
        }),
      ]);
      if (!expRes.ok) { const b = await expRes.json(); setError(b.error); return; }
      if (!revRes.ok) { const b = await revRes.json(); setError(b.error); return; }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const inp = 'w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500';
  const row = (label: string, value: string, onChange?: (v: string) => void, readOnly = false) => (
    <div className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
      <span className="text-sm text-gray-400 w-40 shrink-0">{label}</span>
      {onChange && !readOnly ? (
        <input type="number" min="0" value={value} onChange={e => onChange(e.target.value)} className={`${inp} text-right`} />
      ) : (
        <span className="text-sm text-white font-medium">{value}</span>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md bg-gray-900 border-l border-gray-800 flex flex-col h-full overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div>
            <p className="text-white font-semibold">{trip.vehicle_name || 'Trip Detail'}</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {new Date(trip.start_time).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
          </div>
        ) : (
          <div className="p-5 space-y-5 flex-1">
            {error && (
              <div className="bg-red-500/20 border border-red-500/40 text-red-400 text-sm p-3 rounded-lg">{error}</div>
            )}

            {/* Trip stats */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Distance', value: `${(trip.distance_km ?? 0).toFixed(1)} km` },
                { label: 'Duration', value: trip.duration_minutes ? `${trip.duration_minutes}m` : '—' },
                { label: 'Fuel', value: trip.fuel_consumed_litres ? `${trip.fuel_consumed_litres.toFixed(2)} L` : '—' },
              ].map(s => (
                <div key={s.label} className="bg-gray-800 rounded-lg p-3 text-center">
                  <p className="text-white font-semibold text-sm">{s.value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>

            {/* Revenue */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Revenue</p>
              <div className="bg-gray-800/60 rounded-lg p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-400 w-40 shrink-0">Amount (₹)</label>
                  <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
                    className={`${inp} text-right`} placeholder="0" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-400 w-40 shrink-0">Description</label>
                  <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                    className={inp} placeholder="e.g. Delivery charge" />
                </div>
              </div>
            </div>

            {/* Expenses */}
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Expenses</p>
              <div className="bg-gray-800/60 rounded-lg p-3">
                {row('Fuel Cost (auto)', rupee(expenses?.fuel_cost ?? 0), undefined, true)}
                {row('Maintenance (auto)', rupee(expenses?.maintenance_cost ?? 0), undefined, true)}
                {row('Toll Cost (₹)', toll, setToll)}
                {row('Driver Allowance (₹)', allowance, setAllowance)}
                {row('Other (₹)', other, setOther)}
                <div className="pt-2">
                  <label className="text-sm text-gray-400 block mb-1">Notes</label>
                  <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                    className={`${inp} resize-none`} placeholder="Optional notes..." />
                </div>
              </div>
              {(expenses?._estimated) && (
                <p className="text-xs text-yellow-500/80 mt-1">* Fuel & maintenance auto-calculated from telemetry</p>
              )}
            </div>

            {/* Live profit preview */}
            <div className={`rounded-lg p-4 border ${liveProfit >= 0 ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-400">Revenue</span>
                <span className="text-white">{rupee(Number(amount || 0))}</span>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-gray-400">Total Expenses</span>
                <span className="text-white">{rupee(totalExpense)}</span>
              </div>
              <div className="flex justify-between font-semibold">
                <span className={liveProfit >= 0 ? 'text-green-400' : 'text-red-400'}>Net Profit</span>
                <span className={liveProfit >= 0 ? 'text-green-400' : 'text-red-400'}>{rupee(liveProfit)}</span>
              </div>
            </div>

            <button onClick={handleSave} disabled={saving}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-lg transition-colors">
              {saving ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <Save className="w-4 h-4" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function TripsPage() {
  const [trips, setTrips]             = useState<TripWithExtras[]>([]);
  const [vehicles, setVehicles]       = useState<Vehicle[]>([]);
  const [loading, setLoading]         = useState(false);
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [statusFilter, setStatusFilter]   = useState<'all' | 'active' | 'completed'>('all');
  const [activeTab, setActiveTab]     = useState<'trips' | 'profit'>('trips');
  const [selectedTrip, setSelectedTrip] = useState<TripWithExtras | null>(null);

  // Profit summary state
  const [dailySummary, setDailySummary]     = useState<DailySummary[]>([]);
  const [vehicleRanking, setVehicleRanking] = useState<VehicleRanking[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const loadData = useCallback(async () => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const [tripsRes, vehiclesRes] = await Promise.all([
        supabase
          .from('trips')
          .select('*, vehicles(name), gap_count, gap_duration_minutes, data_confidence_score, total_revenue, total_expense, profit')
          .order('start_time', { ascending: false })
          .limit(200),
        supabase.from('vehicles').select('*'),
      ]);
      if (tripsRes.data) {
        setTrips(tripsRes.data.map((t: any) => ({ ...t, vehicle_name: t.vehicles?.name })));
      }
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
    } catch (e) {
      console.error('Error loading trips:', e);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${EDGE}?action=summary&days=30`, {
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!res.ok) return;
      const body = await res.json();
      setDailySummary(body.daily ?? []);
      setVehicleRanking(body.vehicles ?? []);
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (activeTab === 'profit') loadSummary(); }, [activeTab, loadSummary]);

  const filtered = trips.filter(t => {
    if (vehicleFilter !== 'all' && t.vehicle_id !== vehicleFilter) return false;
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    return true;
  });

  const totalDistance  = trips.reduce((s, t) => s + (t.distance_km || 0), 0);
  const totalFuel      = trips.reduce((s, t) => s + (t.fuel_consumed_litres || 0), 0);
  const totalRevenue   = trips.reduce((s, t) => s + (Number(t.total_revenue) || 0), 0);
  const totalExpense   = trips.reduce((s, t) => s + (Number(t.total_expense) || 0), 0);
  const netProfit      = totalRevenue - totalExpense;
  const unreliableCount = trips.filter(t =>
    t.data_confidence_score != null && t.data_confidence_score < 70
  ).length;

  const fmt = (d: string) =>
    new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Trips</h1>
        <p className="text-gray-400">Trip history with profit tracking</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {[
          { label: 'Total Trips',    value: trips.length,                    icon: Route,         color: 'text-blue-500',   bg: 'bg-blue-500/20'   },
          { label: 'Total Revenue',  value: rupee(totalRevenue),              icon: IndianRupee,   color: 'text-green-400',  bg: 'bg-green-500/20'  },
          { label: 'Total Expenses', value: rupee(totalExpense),              icon: DollarSign,    color: 'text-yellow-400', bg: 'bg-yellow-500/20' },
          { label: 'Net Profit',     value: rupee(netProfit),                 icon: netProfit >= 0 ? TrendingUp : TrendingDown, color: netProfit >= 0 ? 'text-green-400' : 'text-red-400', bg: netProfit >= 0 ? 'bg-green-500/20' : 'bg-red-500/20' },
          { label: 'Total Distance', value: `${totalDistance.toFixed(1)} km`, icon: Fuel,         color: 'text-purple-400', bg: 'bg-purple-500/20' },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 rounded-lg p-5 border border-gray-800">
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{s.value}</p>
            <p className="text-sm text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2">
        {(['trips', 'profit'] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors capitalize flex items-center gap-2 ${
              activeTab === tab ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-400 hover:text-white border border-gray-800'
            }`}>
            {tab === 'trips' ? <Route className="w-4 h-4" /> : <BarChart2 className="w-4 h-4" />}
            {tab === 'trips' ? 'Trip List' : 'Profit Summary'}
          </button>
        ))}
      </div>

      {/* ── Trip List Tab ── */}
      {activeTab === 'trips' && (
        <>
          <div className="flex flex-wrap gap-3 bg-gray-900 rounded-lg p-4 border border-gray-800">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Vehicle:</label>
              <select value={vehicleFilter} onChange={e => setVehicleFilter(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500">
                <option value="all">All Vehicles</option>
                {vehicles.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-400">Status:</label>
              {(['all', 'active', 'completed'] as const).map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors capitalize ${
                    statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                  }`}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
              <Car className="w-16 h-16 text-gray-700 mx-auto mb-4" />
              <p className="text-gray-400 text-lg">No trips recorded yet</p>
              <p className="text-gray-600 text-sm mt-2">Trips are detected automatically when vehicles exceed 5 km/h</p>
            </div>
          ) : (
            <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-800">
                      {['Vehicle','Start','End','Duration','Distance','Fuel','Avg Speed','Revenue','Expenses','Profit','Confidence','Status',''].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {filtered.map(trip => (
                      <tr key={trip.id} className={`hover:bg-gray-800/50 transition-colors cursor-pointer ${
                        trip.data_confidence_score != null && trip.data_confidence_score < 70
                          ? 'border-l-2 border-red-500/50' : ''
                      }`} onClick={() => setSelectedTrip(trip)}>
                        <td className="px-4 py-3 text-white font-medium text-sm whitespace-nowrap">{trip.vehicle_name || '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm whitespace-nowrap">{fmt(trip.start_time)}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm whitespace-nowrap">{trip.end_time ? fmt(trip.end_time) : '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm">{trip.duration_minutes ? `${trip.duration_minutes}m` : '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm">{trip.distance_km ? `${trip.distance_km.toFixed(1)} km` : '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm">{trip.fuel_consumed_litres ? `${trip.fuel_consumed_litres.toFixed(2)} L` : '—'}</td>
                        <td className="px-4 py-3 text-gray-300 text-sm">{trip.avg_speed_kmh ? `${trip.avg_speed_kmh} km/h` : '—'}</td>
                        <td className="px-4 py-3 text-sm text-green-400 font-medium">
                          {Number(trip.total_revenue) > 0 ? rupee(Number(trip.total_revenue)) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3 text-sm text-yellow-400 font-medium">
                          {Number(trip.total_expense) > 0 ? rupee(Number(trip.total_expense)) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {Number(trip.total_revenue) > 0 || Number(trip.total_expense) > 0
                            ? <ProfitBadge profit={Number(trip.profit)} />
                            : <span className="text-gray-600 text-xs">—</span>
                          }
                        </td>
                        <td className="px-4 py-3">
                          <ConfidenceBadge score={trip.data_confidence_score} />
                        </td>
                        <td className="px-4 py-3">
                          {trip.status === 'active' ? (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-500/20 text-blue-400">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5 animate-pulse" />Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-500/20 text-green-400">
                              Completed
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <ChevronRight className="w-4 h-4 text-gray-600" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Profit Summary Tab ── */}
      {activeTab === 'profit' && (
        summaryLoading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-500" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Vehicle Profit Ranking */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800">
                <h2 className="text-white font-semibold">Vehicle Profit Ranking</h2>
                <p className="text-xs text-gray-500 mt-0.5">All completed trips</p>
              </div>
              {vehicleRanking.length === 0 ? (
                <p className="text-gray-500 text-sm p-6 text-center">No data yet — save revenue & expenses on completed trips</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {['Vehicle','Trips','Revenue','Expenses','Net Profit','Margin'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {vehicleRanking.map(v => (
                        <tr key={v.vehicle_id} className="hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-white font-medium text-sm">{v.vehicle_name}</td>
                          <td className="px-4 py-3 text-gray-300 text-sm">{v.completed_trips}</td>
                          <td className="px-4 py-3 text-green-400 text-sm font-medium">{rupee(Number(v.total_revenue))}</td>
                          <td className="px-4 py-3 text-yellow-400 text-sm font-medium">{rupee(Number(v.total_expense))}</td>
                          <td className="px-4 py-3"><ProfitBadge profit={Number(v.net_profit)} /></td>
                          <td className="px-4 py-3">
                            <span className={`text-sm font-medium ${Number(v.profit_margin_pct) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {Number(v.profit_margin_pct).toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Daily Profit (last 30 days) */}
            <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800">
                <h2 className="text-white font-semibold">Daily Profit — Last 30 Days</h2>
              </div>
              {dailySummary.length === 0 ? (
                <p className="text-gray-500 text-sm p-6 text-center">No completed trips with profit data in the last 30 days</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-800">
                        {['Date','Trips','Distance','Revenue','Expenses','Net Profit'].map(h => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {dailySummary.map(d => (
                        <tr key={d.date} className="hover:bg-gray-800/50">
                          <td className="px-4 py-3 text-white text-sm font-medium">
                            {new Date(d.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                          </td>
                          <td className="px-4 py-3 text-gray-300 text-sm">{d.trip_count}</td>
                          <td className="px-4 py-3 text-gray-300 text-sm">{Number(d.total_distance_km).toFixed(1)} km</td>
                          <td className="px-4 py-3 text-green-400 text-sm font-medium">{rupee(Number(d.total_revenue))}</td>
                          <td className="px-4 py-3 text-yellow-400 text-sm font-medium">{rupee(Number(d.total_expense))}</td>
                          <td className="px-4 py-3"><ProfitBadge profit={Number(d.net_profit)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )
      )}

      {/* Trip Detail Slide-out */}
      {selectedTrip && (
        <TripDetailPanel
          trip={selectedTrip}
          onClose={() => setSelectedTrip(null)}
          onSaved={loadData}
        />
      )}
    </div>
  );
}

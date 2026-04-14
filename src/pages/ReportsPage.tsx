import { useState, useEffect, useRef } from 'react';
import {
  FileText, Download, Calendar, Filter, ChevronDown,
  Loader, AlertTriangle, Printer,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportType   = 'trip_summary' | 'fuel_consumption' | 'driver_behaviour' | 'alert_history' | 'cost_breakdown';
type DatePreset   = '7d' | '30d' | '90d' | 'month' | 'custom';

interface ReportRow { [key: string]: string | number | null }
interface Vehicle   { id: string; name: string; vin: string }

// ─── Report config ────────────────────────────────────────────────────────────

const REPORT_CONFIGS: Record<ReportType, { label: string; description: string; columns: string[] }> = {
  trip_summary: {
    label:       'Trip Summary',
    description: 'Start/end location, distance, duration, and average speed per trip.',
    columns:     ['Vehicle', 'Start Time', 'End Time', 'Distance (km)', 'Duration', 'Avg Speed (km/h)'],
  },
  fuel_consumption: {
    label:       'Fuel Consumption',
    description: 'Fuel fill events with volume, cost, and efficiency metrics.',
    columns:     ['Vehicle', 'Date', 'Fuel Level (%)', 'Event Type', 'Location'],
  },
  driver_behaviour: {
    label:       'Driver Behaviour',
    description: 'Harsh braking, acceleration, idling, and overall score per session.',
    columns:     ['Vehicle', 'Date', 'Score', 'Harsh Brakes', 'Harsh Accel', 'Idle Time (min)', 'Overspeed Events'],
  },
  alert_history: {
    label:       'Alert History',
    description: 'All events and alerts generated within the date range.',
    columns:     ['Vehicle', 'Event Type', 'Severity', 'Timestamp', 'Details'],
  },
  cost_breakdown: {
    label:       'Cost Breakdown',
    description: 'Per-vehicle cost predictions and actuals.',
    columns:     ['Vehicle', 'Period', 'Fuel Cost (₹)', 'Maintenance Cost (₹)', 'Total Cost (₹)'],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function presetToDates(p: DatePreset): { start: string; end: string } {
  const now   = new Date();
  const end   = now.toISOString().slice(0, 10);
  const start = new Date(now);
  if      (p === '7d')    { start.setDate(start.getDate() - 7); }
  else if (p === '30d')   { start.setDate(start.getDate() - 30); }
  else if (p === '90d')   { start.setDate(start.getDate() - 90); }
  else if (p === 'month') { start.setDate(1); }
  return { start: start.toISOString().slice(0, 10), end };
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ─── Vehicle filter dropdown ──────────────────────────────────────────────────

interface VehicleFilterProps {
  vehicles: Vehicle[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

function VehicleFilter({ vehicles, selected, onChange }: VehicleFilterProps) {
  const [open, setOpen] = useState(false);
  const ref             = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]);
  };

  const label =
    selected.length === 0
      ? 'All Vehicles'
      : `${selected.length} vehicle${selected.length !== 1 ? 's' : ''}`;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-600 text-white text-sm rounded-lg transition-colors min-w-[160px] justify-between"
      >
        <span className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-gray-400" />
          {label}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 z-20 bg-gray-900 border border-gray-700 rounded-xl shadow-xl min-w-[200px] max-h-48 overflow-y-auto">
          {vehicles.length === 0 ? (
            <p className="px-4 py-3 text-gray-400 text-sm">No vehicles found</p>
          ) : (
            <div className="py-1">
              <label className="flex items-center gap-2 px-4 py-2 hover:bg-gray-800 cursor-pointer text-sm text-gray-300 border-b border-gray-800">
                <input
                  type="checkbox"
                  checked={selected.length === 0}
                  onChange={() => onChange([])}
                  className="accent-blue-500"
                />
                All Vehicles
              </label>
              {vehicles.map(v => (
                <label
                  key={v.id}
                  className="flex items-center gap-2 px-4 py-2 hover:bg-gray-800 cursor-pointer text-sm text-gray-300"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(v.id)}
                    onChange={() => toggle(v.id)}
                    className="accent-blue-500"
                  />
                  <span className="truncate">{v.name || v.vin}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReportsPage() {
  const [reportType, setReportType]             = useState<ReportType>('trip_summary');
  const [preset, setPreset]                     = useState<DatePreset>('30d');
  const { start: initStart, end: initEnd }      = presetToDates('30d');
  const [startDate, setStartDate]               = useState(initStart);
  const [endDate, setEndDate]                   = useState(initEnd);
  const [vehicles, setVehicles]                 = useState<Vehicle[]>([]);
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<string[]>([]);
  const [rows, setRows]                         = useState<ReportRow[]>([]);
  const [columns, setColumns]                   = useState<string[]>([]);
  const [loading, setLoading]                   = useState(false);
  const [error, setError]                       = useState<string | null>(null);
  const [fleetId, setFleetId]                   = useState<string | null>(null);

  const [reportTypeOpen, setReportTypeOpen]     = useState(false);
  const reportTypeRef                           = useRef<HTMLDivElement>(null);
  const tableRef                                = useRef<HTMLDivElement>(null);

  // ─── Close report type dropdown on outside click ──────────────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (reportTypeRef.current && !reportTypeRef.current.contains(e.target as Node)) {
        setReportTypeOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ─── Load fleet + vehicles on mount ──────────────────────────────────────

  useEffect(() => {
    loadMeta();
  }, []);

  const loadMeta = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: fleetData } = await supabase
        .from('fleets')
        .select('id')
        .eq('manager_id', user.id)
        .single();
      if (!fleetData) return;

      setFleetId(fleetData.id);

      const { data: vehicleData } = await supabase
        .from('vehicles')
        .select('id, name, vin')
        .eq('fleet_id', fleetData.id)
        .order('name', { ascending: true });
      setVehicles(vehicleData ?? []);
    } catch (e) {
      console.error('Error loading reports meta:', e);
    }
  };

  // ─── Recompute dates when preset changes ──────────────────────────────────

  useEffect(() => {
    if (preset !== 'custom') {
      const { start, end } = presetToDates(preset);
      setStartDate(start);
      setEndDate(end);
    }
  }, [preset]);

  // ─── Run report ───────────────────────────────────────────────────────────

  const runReport = async () => {
    if (!fleetId) return;
    setLoading(true);
    setError(null);
    setRows([]);

    const vIds       = selectedVehicleIds.length > 0 ? selectedVehicleIds : vehicles.map(v => v.id);
    const vehicleMap = Object.fromEntries(vehicles.map(v => [v.id, v.name]));

    try {
      if (reportType === 'trip_summary') {
        const { data, error } = await supabase
          .from('trips')
          .select('vehicle_id, start_time, end_time, distance_km, duration_seconds, avg_speed_kmh')
          .in('vehicle_id', vIds)
          .gte('start_time', startDate)
          .lte('start_time', endDate + 'T23:59:59Z')
          .order('start_time', { ascending: false })
          .limit(500);
        if (error) throw error;
        setRows((data ?? []).map((r: any) => ({
          'Vehicle':          vehicleMap[r.vehicle_id] ?? r.vehicle_id,
          'Start Time':       r.start_time ? new Date(r.start_time).toLocaleString() : '—',
          'End Time':         r.end_time   ? new Date(r.end_time).toLocaleString()   : '—',
          'Distance (km)':    r.distance_km    != null ? Number(r.distance_km).toFixed(1)    : '—',
          'Duration':         r.duration_seconds != null ? formatDuration(r.duration_seconds) : '—',
          'Avg Speed (km/h)': r.avg_speed_kmh   != null ? Number(r.avg_speed_kmh).toFixed(1)  : '—',
        })));
      }
      else if (reportType === 'fuel_consumption') {
        const { data, error } = await supabase
          .from('fuel_events')
          .select('vehicle_id, created_at, fuel_level_pct, event_type, latitude, longitude')
          .in('vehicle_id', vIds)
          .gte('created_at', startDate)
          .lte('created_at', endDate + 'T23:59:59Z')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        setRows((data ?? []).map((r: any) => ({
          'Vehicle':        vehicleMap[r.vehicle_id] ?? r.vehicle_id,
          'Date':           new Date(r.created_at).toLocaleString(),
          'Fuel Level (%)': r.fuel_level_pct != null ? Number(r.fuel_level_pct).toFixed(1) : '—',
          'Event Type':     r.event_type ?? '—',
          'Location':       r.latitude && r.longitude
            ? `${Number(r.latitude).toFixed(4)}, ${Number(r.longitude).toFixed(4)}`
            : '—',
        })));
      }
      else if (reportType === 'driver_behaviour') {
        const { data, error } = await supabase
          .from('driver_behavior')
          .select('vehicle_id, created_at, score, harsh_brake_count, harsh_accel_count, idle_time_seconds, overspeed_count')
          .in('vehicle_id', vIds)
          .gte('created_at', startDate)
          .lte('created_at', endDate + 'T23:59:59Z')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        setRows((data ?? []).map((r: any) => ({
          'Vehicle':          vehicleMap[r.vehicle_id] ?? r.vehicle_id,
          'Date':             new Date(r.created_at).toLocaleString(),
          'Score':            r.score              != null ? Number(r.score).toFixed(1)                  : '—',
          'Harsh Brakes':     r.harsh_brake_count  ?? '—',
          'Harsh Accel':      r.harsh_accel_count  ?? '—',
          'Idle Time (min)':  r.idle_time_seconds  != null ? (r.idle_time_seconds / 60).toFixed(0)       : '—',
          'Overspeed Events': r.overspeed_count    ?? '—',
        })));
      }
      else if (reportType === 'alert_history') {
        const { data, error } = await supabase
          .from('vehicle_events')
          .select('vehicle_id, event_type, severity, created_at, details')
          .in('vehicle_id', vIds)
          .gte('created_at', startDate)
          .lte('created_at', endDate + 'T23:59:59Z')
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        setRows((data ?? []).map((r: any) => ({
          'Vehicle':    vehicleMap[r.vehicle_id] ?? r.vehicle_id,
          'Event Type': r.event_type ?? '—',
          'Severity':   r.severity   ?? '—',
          'Timestamp':  new Date(r.created_at).toLocaleString(),
          'Details':    r.details ? JSON.stringify(r.details).slice(0, 80) : '—',
        })));
      }
      else if (reportType === 'cost_breakdown') {
        const { data, error } = await supabase
          .from('cost_predictions')
          .select('vehicle_id, prediction_date, fuel_cost, maintenance_cost, total_cost')
          .in('vehicle_id', vIds)
          .gte('prediction_date', startDate)
          .lte('prediction_date', endDate)
          .order('prediction_date', { ascending: false })
          .limit(500);
        if (error) throw error;
        setRows((data ?? []).map((r: any) => ({
          'Vehicle':              vehicleMap[r.vehicle_id] ?? r.vehicle_id,
          'Period':               r.prediction_date ?? '—',
          'Fuel Cost (₹)':        r.fuel_cost        != null ? `₹${Number(r.fuel_cost).toFixed(0)}`        : '—',
          'Maintenance Cost (₹)': r.maintenance_cost != null ? `₹${Number(r.maintenance_cost).toFixed(0)}` : '—',
          'Total Cost (₹)':       r.total_cost       != null ? `₹${Number(r.total_cost).toFixed(0)}`       : '—',
        })));
      }
      setColumns(REPORT_CONFIGS[reportType].columns);
    } catch (e: any) {
      setError(e.message ?? 'Failed to run report');
    } finally {
      setLoading(false);
    }
  };

  // ─── CSV export ───────────────────────────────────────────────────────────

  const exportCsv = () => {
    if (rows.length === 0) return;
    const cols   = columns;
    const header = cols.join(',');
    const body   = rows.map(r =>
      cols.map(c => {
        const v = String(r[c] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    ).join('\n');
    const csv  = `${header}\n${body}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${reportType}_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Print ────────────────────────────────────────────────────────────────

  const printReport = () => {
    window.print();
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const PRESET_LABELS: Record<DatePreset, string> = {
    '7d':    'Last 7 days',
    '30d':   'Last 30 days',
    '90d':   'Last 90 days',
    'month': 'This month',
    'custom':'Custom',
  };

  return (
    <>
      {/* Print styles */}
      <style>{`
        @media print {
          .print-hidden { display: none !important; }
          .print-table  { display: block !important; overflow: visible !important; max-height: none !important; }
          body { background: white !important; color: black !important; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 6px 10px; font-size: 11px; }
          th { background: #f0f0f0; }
        }
      `}</style>

      <div className="min-h-screen bg-gray-950 text-white p-6 space-y-6">

        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 print-hidden">
          <div className="p-2 bg-blue-600/20 rounded-lg">
            <FileText className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Custom Reports</h1>
            <p className="text-sm text-gray-400">Build and export fleet reports for any date range</p>
          </div>
        </div>

        {/* ── Filters row ─────────────────────────────────────────────────── */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4 print-hidden">

          <div className="flex flex-wrap items-end gap-3">

            {/* Report type dropdown */}
            <div className="space-y-1.5" ref={reportTypeRef}>
              <label className="text-xs text-gray-400 font-medium uppercase tracking-wide">Report Type</label>
              <div className="relative">
                <button
                  onClick={() => setReportTypeOpen(o => !o)}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-800 border border-gray-700 hover:border-gray-600 text-white text-sm rounded-lg transition-colors min-w-[200px] justify-between"
                >
                  <span>{REPORT_CONFIGS[reportType].label}</span>
                  <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${reportTypeOpen ? 'rotate-180' : ''}`} />
                </button>
                {reportTypeOpen && (
                  <div className="absolute top-full mt-1 left-0 z-20 bg-gray-900 border border-gray-700 rounded-xl shadow-xl min-w-[220px]">
                    {(Object.keys(REPORT_CONFIGS) as ReportType[]).map(rt => (
                      <button
                        key={rt}
                        onClick={() => { setReportType(rt); setReportTypeOpen(false); setRows([]); setColumns([]); }}
                        className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-800 transition-colors first:rounded-t-xl last:rounded-b-xl ${
                          reportType === rt ? 'text-blue-400 bg-blue-900/20' : 'text-gray-300'
                        }`}
                      >
                        <div className="font-medium">{REPORT_CONFIGS[rt].label}</div>
                        <div className="text-xs text-gray-500 mt-0.5 truncate">{REPORT_CONFIGS[rt].description}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Date preset buttons */}
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium uppercase tracking-wide">Date Range</label>
              <div className="flex items-center gap-1">
                {(['7d', '30d', '90d', 'month', 'custom'] as DatePreset[]).map(p => (
                  <button
                    key={p}
                    onClick={() => setPreset(p)}
                    className={`px-3 py-2 text-sm rounded-lg transition-colors ${
                      preset === p
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700'
                    }`}
                  >
                    {PRESET_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>

            {/* Vehicle filter */}
            <div className="space-y-1.5">
              <label className="text-xs text-gray-400 font-medium uppercase tracking-wide">Vehicles</label>
              <VehicleFilter
                vehicles={vehicles}
                selected={selectedVehicleIds}
                onChange={setSelectedVehicleIds}
              />
            </div>

          </div>

          {/* Custom date inputs */}
          {preset === 'custom' && (
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">From</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400">To</label>
                <input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {/* Run button */}
          <div className="flex justify-end">
            <button
              onClick={runReport}
              disabled={loading || !fleetId}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm rounded-lg transition-colors"
            >
              {loading ? (
                <><Loader className="w-4 h-4 animate-spin" /> Running…</>
              ) : (
                <><Calendar className="w-4 h-4" /> Run Report</>
              )}
            </button>
          </div>

        </div>

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {error && (
          <div className="flex items-center gap-2 bg-red-900/40 border border-red-700 text-red-300 rounded-xl px-4 py-3 text-sm print-hidden">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Results area ────────────────────────────────────────────────── */}
        {(rows.length > 0 || loading) && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

            {/* Results header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 print-hidden">
              <span className="text-sm text-gray-400">
                {loading ? 'Loading…' : `${rows.length} row${rows.length !== 1 ? 's' : ''}`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={exportCsv}
                  disabled={rows.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 hover:text-white text-sm rounded-lg transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </button>
                <button
                  onClick={printReport}
                  disabled={rows.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 hover:text-white text-sm rounded-lg transition-colors"
                >
                  <Printer className="w-4 h-4" />
                  Print / PDF
                </button>
              </div>
            </div>

            {/* Table */}
            {loading ? (
              <div className="flex items-center justify-center py-12 text-gray-400 print-hidden">
                <Loader className="w-5 h-5 animate-spin mr-2" />
                Running report…
              </div>
            ) : (
              <div ref={tableRef} className="overflow-x-auto overflow-y-auto max-h-[60vh] print-table">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-900">
                    <tr className="border-b border-gray-800">
                      {columns.map(col => (
                        <th
                          key={col}
                          className="text-left text-gray-400 font-medium px-4 py-3 whitespace-nowrap"
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {rows.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-800/40 transition-colors">
                        {columns.map(col => (
                          <td key={col} className="px-4 py-3 text-gray-300 whitespace-nowrap">
                            {row[col] != null ? String(row[col]) : '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Empty state — after a run with no results */}
        {!loading && rows.length === 0 && columns.length > 0 && !error && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-6 py-12 text-center print-hidden">
            <FileText className="w-8 h-8 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400 text-sm">No data found for the selected filters.</p>
            <p className="text-gray-600 text-xs mt-1">Try widening the date range or selecting different vehicles.</p>
          </div>
        )}

        {/* ── Scheduled Reports — Coming Soon ─────────────────────────────── */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 print-hidden">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-white font-semibold text-base flex items-center gap-2">
                <Calendar className="w-4 h-4 text-gray-500" />
                Scheduled Reports
                <span className="text-xs font-normal bg-gray-700 text-gray-400 px-2 py-0.5 rounded-full">
                  Coming Soon
                </span>
              </h3>
              <p className="text-sm text-gray-500 max-w-md">
                Automatically generate and email reports on a daily, weekly, or monthly schedule.
                Perfect for keeping stakeholders up to date without manual effort.
              </p>
            </div>
            <button
              disabled
              className="shrink-0 flex items-center gap-1.5 px-4 py-2 border border-gray-700 text-gray-600 text-sm font-medium rounded-lg cursor-not-allowed opacity-50"
            >
              <Calendar className="w-4 h-4" />
              Schedule Report
            </button>
          </div>
        </div>

      </div>
    </>
  );
}

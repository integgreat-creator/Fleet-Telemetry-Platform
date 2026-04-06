import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bug,
  RefreshCw,
  Play,
  Database,
  Wifi,
  AlertCircle,
  CheckCircle,
  Clock,
  Download,
  Trash2,
  Eye,
  Zap,
} from 'lucide-react';
import { supabase, type Vehicle, type Alert, type SensorData } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'telemetry' | 'sync' | 'api' | 'replay';

interface LiveReading {
  sensor_type: string;
  latest_value: number;
  unit: string;
  timestamp: string;
  count: number;
}

type SyncStatus = 'pass' | 'warn' | 'fail';

interface SyncCheck {
  label: string;
  status: SyncStatus;
  detail?: string;
}

interface VehicleSyncResult {
  vehicle: Vehicle;
  checks: SyncCheck[];
}

interface ApiMonitorRow {
  id: string;
  vehicle_id: string;
  vehicle_name: string;
  sensor_type: string;
  value: number;
  severity: string;
  message: string;
  created_at: string;
}

interface VehicleReadingCount {
  vehicle_id: string;
  vehicle_name: string;
  count: number;
}

interface ReplayRow {
  id: string;
  timestamp: string;
  sensor_type: string;
  value: number;
  unit: string;
}

const REPLAY_SENSORS = [
  'rpm',
  'speed',
  'coolantTemp',
  'fuelLevel',
  'engineLoad',
  'batteryVoltage',
  'throttlePosition',
];

const SENSOR_UNITS: Record<string, string> = {
  rpm: 'RPM',
  speed: 'km/h',
  coolantTemp: '°C',
  fuelLevel: '%',
  engineLoad: '%',
  batteryVoltage: 'V',
  throttlePosition: '%',
};

// ─── Helper: format relative time ────────────────────────────────────────────

function relativeTime(ts: string): string {
  const diffMs = Date.now() - new Date(ts).getTime();
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  return `${Math.floor(diffS / 3600)}h ago`;
}

// ─── Staleness colour ─────────────────────────────────────────────────────────

function stalenessColor(ts: string | undefined): string {
  if (!ts) return 'text-gray-500';
  const ageS = (Date.now() - new Date(ts).getTime()) / 1000;
  if (ageS < 5) return 'text-emerald-400';
  if (ageS < 30) return 'text-yellow-400';
  return 'text-red-400';
}

// ─── Export CSV helper ────────────────────────────────────────────────────────

function exportCsv(rows: ReplayRow[], filename = 'sensor_replay.csv') {
  const header = 'timestamp,sensor_type,value,unit\n';
  const body = rows
    .map((r) => `${r.timestamp},${r.sensor_type},${r.value},${r.unit}`)
    .join('\n');
  const blob = new Blob([header + body], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// =============================================================================
// PAGE COMPONENT
// =============================================================================

export default function DebugToolsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('telemetry');

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'telemetry', label: 'Live Telemetry',  icon: <Wifi  className="w-4 h-4" /> },
    { id: 'sync',      label: 'Vehicle Sync',     icon: <Database className="w-4 h-4" /> },
    { id: 'api',       label: 'API Monitor',      icon: <Zap   className="w-4 h-4" /> },
    { id: 'replay',    label: 'Data Replay',      icon: <Play  className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Bug className="w-6 h-6 text-indigo-400" />
        <h1 className="text-2xl font-bold text-white">Debug Tools</h1>
        <span className="ml-2 px-2 py-0.5 rounded text-xs font-medium bg-indigo-900/60 text-indigo-300 border border-indigo-700">
          Fleet Manager Only
        </span>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 border-b border-gray-800 pb-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={[
              'flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors -mb-px border-b-2',
              activeTab === t.id
                ? 'border-indigo-500 text-indigo-300 bg-gray-900'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-900/40',
            ].join(' ')}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      <div>
        {activeTab === 'telemetry' && <LiveTelemetryTab />}
        {activeTab === 'sync'      && <VehicleSyncTab />}
        {activeTab === 'api'       && <ApiMonitorTab />}
        {activeTab === 'replay'    && <DataReplayTab />}
      </div>
    </div>
  );
}

// =============================================================================
// TAB 1 — Live Telemetry Inspector
// =============================================================================

function LiveTelemetryTab() {
  const [vehicles, setVehicles]       = useState<Vehicle[]>([]);
  const [selectedId, setSelectedId]   = useState<string>('');
  const [readings, setReadings]       = useState<Map<string, LiveReading>>(new Map());
  const [lastUpdate, setLastUpdate]   = useState<string | null>(null);
  const channelRef                    = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Load vehicle list once
  useEffect(() => {
    supabase
      .from('vehicles')
      .select('id, name, vin, make, model, year, owner_id, fleet_id, is_active, health_score, last_connected, fuel_price_per_litre, avg_km_per_litre, created_at, updated_at')
      .order('name')
      .then(({ data }) => { if (data) setVehicles(data as Vehicle[]); });
  }, []);

  // Re-subscribe when selected vehicle changes
  useEffect(() => {
    // Tear down previous subscription
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    if (!selectedId) return;

    // Seed initial readings for this vehicle
    supabase
      .from('sensor_data')
      .select('sensor_type, value, unit, timestamp')
      .eq('vehicle_id', selectedId)
      .order('timestamp', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        if (!data) return;
        const map = new Map<string, LiveReading>();
        // Walk newest-first; first occurrence per sensor_type wins (latest value)
        for (const row of data) {
          if (!map.has(row.sensor_type)) {
            map.set(row.sensor_type, {
              sensor_type:   row.sensor_type,
              latest_value:  row.value,
              unit:          row.unit,
              timestamp:     row.timestamp,
              count:         data.filter((r) => r.sensor_type === row.sensor_type).length,
            });
          }
        }
        setReadings(new Map(map));
        if (data.length > 0) setLastUpdate(data[0].timestamp);
      });

    // Realtime subscription
    const channel = supabase
      .channel(`sensor_data:vehicle:${selectedId}`)
      .on(
        'postgres_changes',
        {
          event:  'INSERT',
          schema: 'public',
          table:  'sensor_data',
          filter: `vehicle_id=eq.${selectedId}`,
        },
        (payload) => {
          const row = payload.new as SensorData;
          setReadings((prev) => {
            const next = new Map(prev);
            const existing = next.get(row.sensor_type);
            next.set(row.sensor_type, {
              sensor_type:  row.sensor_type,
              latest_value: row.value,
              unit:         row.unit,
              timestamp:    row.timestamp,
              count:        (existing?.count ?? 0) + 1,
            });
            return next;
          });
          setLastUpdate(row.timestamp);
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [selectedId]);

  // Ticker to force re-render every second so staleness colours update
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const readingRows = Array.from(readings.values()).sort((a, b) =>
    a.sensor_type.localeCompare(b.sensor_type)
  );

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4 text-gray-400" />
          <label className="text-sm text-gray-400">Vehicle</label>
        </div>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent min-w-[220px]"
        >
          <option value="">— select a vehicle —</option>
          {vehicles.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.vin})
            </option>
          ))}
        </select>

        {selectedId && (
          <button
            onClick={() => { setReadings(new Map()); setLastUpdate(null); }}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-300 border border-red-800 rounded-lg hover:bg-red-900/30 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Clear readings
          </button>
        )}

        {lastUpdate && (
          <span className={`text-xs font-mono ${stalenessColor(lastUpdate)}`}>
            Last update: {relativeTime(lastUpdate)}
          </span>
        )}
      </div>

      {/* Status indicator */}
      {selectedId && (
        <div className="flex items-center gap-2 text-xs">
          <span className={`w-2 h-2 rounded-full ${lastUpdate && (Date.now() - new Date(lastUpdate).getTime()) < 30000 ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
          <span className="text-gray-400">
            Realtime subscription active — {readingRows.length} sensor type{readingRows.length !== 1 ? 's' : ''} tracked
          </span>
        </div>
      )}

      {/* Readings table */}
      {readingRows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-900 border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Sensor Type</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Latest Value</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Unit</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Timestamp</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Readings</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {readingRows.map((r) => (
                <tr key={r.sensor_type} className="hover:bg-gray-900/40 transition-colors">
                  <td className="px-4 py-3 font-mono text-indigo-300">{r.sensor_type}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-white">
                    {typeof r.latest_value === 'number' ? r.latest_value.toFixed(1) : r.latest_value}
                  </td>
                  <td className="px-4 py-3 text-gray-400">{r.unit}</td>
                  <td className={`px-4 py-3 font-mono text-xs ${stalenessColor(r.timestamp)}`}>
                    {relativeTime(r.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">{r.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-40 rounded-xl border border-dashed border-gray-700 text-gray-500">
          {selectedId ? (
            <>
              <Clock className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">Waiting for sensor data…</p>
            </>
          ) : (
            <>
              <Wifi className="w-8 h-8 mb-2 opacity-40" />
              <p className="text-sm">Select a vehicle to begin monitoring</p>
            </>
          )}
        </div>
      )}

      {/* Legend */}
      <div className="flex gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Updated &lt;5 s ago</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> Updated &lt;30 s ago</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> Stale (&gt;30 s)</span>
      </div>
    </div>
  );
}

// =============================================================================
// TAB 2 — Vehicle Sync Checker
// =============================================================================

function VehicleSyncTab() {
  const [results,  setResults]  = useState<VehicleSyncResult[]>([]);
  const [running,  setRunning]  = useState(false);
  const [ranOnce,  setRanOnce]  = useState(false);

  const runCheck = useCallback(async () => {
    setRunning(true);
    setRanOnce(true);
    try {
      const { data: vehicles } = await supabase
        .from('vehicles')
        .select('id, name, vin, make, model, year, owner_id, fleet_id, is_active, health_score, last_connected, fuel_price_per_litre, avg_km_per_litre, created_at, updated_at')
        .order('name');

      if (!vehicles || vehicles.length === 0) {
        setResults([]);
        return;
      }

      const now = new Date();
      const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

      // Batch fetch: latest sensor_data timestamp per vehicle
      const { data: recentSensor } = await supabase
        .from('sensor_data')
        .select('vehicle_id, timestamp')
        .gte('timestamp', cutoff24h)
        .in('vehicle_id', vehicles.map((v) => v.id));

      // Batch fetch: threshold counts per vehicle
      const { data: thresholdRows } = await supabase
        .from('thresholds')
        .select('vehicle_id')
        .in('vehicle_id', vehicles.map((v) => v.id));

      // Build sets for O(1) lookup
      const vehiclesWithRecentSensor = new Set(
        (recentSensor ?? []).map((r: { vehicle_id: string; timestamp: string }) => r.vehicle_id)
      );
      const latestSensorTs = (recentSensor ?? []).reduce<Record<string, string>>(
        (acc, r: { vehicle_id: string; timestamp: string }) => {
          if (!acc[r.vehicle_id] || r.timestamp > acc[r.vehicle_id]) acc[r.vehicle_id] = r.timestamp;
          return acc;
        },
        {}
      );
      const thresholdCounts = (thresholdRows ?? []).reduce<Record<string, number>>(
        (acc, r: { vehicle_id: string }) => {
          acc[r.vehicle_id] = (acc[r.vehicle_id] ?? 0) + 1;
          return acc;
        },
        {}
      );

      const output: VehicleSyncResult[] = (vehicles as Vehicle[]).map((v) => {
        const hasSensor  = vehiclesWithRecentSensor.has(v.id);
        const hasFleetId = !!v.fleet_id;
        const sensorTs   = latestSensorTs[v.id];

        // Check 3: is_active should be true if last sensor is recent
        let activeMatchStatus: SyncStatus = 'pass';
        let activeMatchDetail = '';
        if (sensorTs) {
          const sensorAge = (now.getTime() - new Date(sensorTs).getTime()) / 1000 / 60; // minutes
          if (v.is_active && sensorAge > 60) {
            activeMatchStatus = 'warn';
            activeMatchDetail = 'Marked active but last reading was >60 min ago';
          } else if (!v.is_active && sensorAge < 5) {
            activeMatchStatus = 'warn';
            activeMatchDetail = 'Marked inactive but received data in last 5 min';
          }
        } else if (v.is_active) {
          activeMatchStatus = 'warn';
          activeMatchDetail = 'Marked active but no sensor data in last 24h';
        }

        const threshCount = thresholdCounts[v.id] ?? 0;

        return {
          vehicle: v,
          checks: [
            {
              label:  'Sensor data in last 24h',
              status: hasSensor ? 'pass' : 'fail',
              detail: hasSensor ? undefined : 'No readings received in the past 24 hours',
            },
            {
              label:  'fleet_id assigned',
              status: hasFleetId ? 'pass' : 'fail',
              detail: hasFleetId ? undefined : 'Vehicle is not assigned to any fleet',
            },
            {
              label:  'is_active consistent with telemetry',
              status: activeMatchStatus,
              detail: activeMatchDetail || undefined,
            },
            {
              label:  'Thresholds configured',
              status: threshCount > 0 ? 'pass' : 'warn',
              detail: threshCount > 0 ? `${threshCount} threshold(s) set` : 'No thresholds configured — alerts will not fire',
            },
          ],
        };
      });

      setResults(output);
    } finally {
      setRunning(false);
    }
  }, []);

  const allChecks   = results.flatMap((r) => r.checks);
  const passCount   = allChecks.filter((c) => c.status === 'pass').length;
  const warnCount   = allChecks.filter((c) => c.status === 'warn').length;
  const failCount   = allChecks.filter((c) => c.status === 'fail').length;

  const statusIcon = (s: SyncStatus) => {
    if (s === 'pass') return <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />;
    if (s === 'warn') return <AlertCircle className="w-4 h-4 text-yellow-400 flex-shrink-0" />;
    return <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
  };

  return (
    <div className="space-y-5">
      {/* Action bar */}
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={runCheck}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {running
            ? <RefreshCw className="w-4 h-4 animate-spin" />
            : <Play className="w-4 h-4" />}
          {running ? 'Running checks…' : 'Run Sync Check'}
        </button>

        {ranOnce && !running && (
          <div className="flex gap-3 text-sm">
            <span className="flex items-center gap-1.5 text-emerald-400">
              <CheckCircle className="w-3.5 h-3.5" /> {passCount} Pass
            </span>
            <span className="flex items-center gap-1.5 text-yellow-400">
              <AlertCircle className="w-3.5 h-3.5" /> {warnCount} Warn
            </span>
            <span className="flex items-center gap-1.5 text-red-400">
              <AlertCircle className="w-3.5 h-3.5" /> {failCount} Fail
            </span>
          </div>
        )}
      </div>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-4">
          {results.map(({ vehicle, checks }) => (
            <div key={vehicle.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-sm font-semibold text-white">{vehicle.name}</span>
                <span className="text-xs text-gray-500 font-mono">{vehicle.vin}</span>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full border ${vehicle.is_active ? 'bg-emerald-950 border-emerald-700 text-emerald-400' : 'bg-gray-800 border-gray-700 text-gray-400'}`}>
                  {vehicle.is_active ? 'active' : 'inactive'}
                </span>
              </div>
              <ul className="space-y-2">
                {checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2 text-sm">
                    {statusIcon(c.status)}
                    <span className={c.status === 'fail' ? 'text-red-300' : c.status === 'warn' ? 'text-yellow-300' : 'text-gray-300'}>
                      {c.label}
                    </span>
                    {c.detail && (
                      <span className="text-xs text-gray-500 ml-1">— {c.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {ranOnce && results.length === 0 && !running && (
        <div className="flex flex-col items-center justify-center h-32 rounded-xl border border-dashed border-gray-700 text-gray-500">
          <Database className="w-7 h-7 mb-2 opacity-40" />
          <p className="text-sm">No vehicles found</p>
        </div>
      )}

      {!ranOnce && (
        <div className="flex flex-col items-center justify-center h-32 rounded-xl border border-dashed border-gray-700 text-gray-500">
          <Play className="w-7 h-7 mb-2 opacity-40" />
          <p className="text-sm">Click "Run Sync Check" to inspect your fleet</p>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// TAB 3 — API Monitor
// =============================================================================

function ApiMonitorTab() {
  const [rows,    setRows]    = useState<ApiMonitorRow[]>([]);
  const [counts,  setCounts]  = useState<VehicleReadingCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      const [alertsRes, sensorCountRes] = await Promise.all([
        supabase
          .from('alerts')
          .select('id, vehicle_id, sensor_type, value, severity, message, created_at, vehicles(name)')
          .order('created_at', { ascending: false })
          .limit(50),

        supabase
          .from('sensor_data')
          .select('vehicle_id, vehicles(name)')
          .gte('timestamp', hourAgo),
      ]);

      if (alertsRes.data) {
        setRows(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          alertsRes.data.map((a: any) => ({
            id:           a.id,
            vehicle_id:   a.vehicle_id,
            vehicle_name: a.vehicles?.name ?? a.vehicle_id.slice(0, 8),
            sensor_type:  a.sensor_type,
            value:        a.value,
            severity:     a.severity,
            message:      a.message,
            created_at:   a.created_at,
          }))
        );
      }

      if (sensorCountRes.data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const byVehicle = (sensorCountRes.data as any[]).reduce<Record<string, { name: string; count: number }>>((acc, row) => {
          const vid  = row.vehicle_id;
          const name = row.vehicles?.name ?? vid.slice(0, 8);
          acc[vid] = { name, count: (acc[vid]?.count ?? 0) + 1 };
          return acc;
        }, {});
        setCounts(
          Object.entries(byVehicle).map(([vid, { name, count }]) => ({
            vehicle_id:   vid,
            vehicle_name: name,
            count,
          })).sort((a, b) => b.count - a.count)
        );
      }

      setLastRefresh(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-refresh every 10 s
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const rowBg = (severity: string) => {
    if (severity === 'critical') return 'bg-red-950/30 border-l-2 border-red-600';
    if (severity === 'warning')  return 'bg-yellow-950/20 border-l-2 border-yellow-600';
    return '';
  };

  return (
    <div className="space-y-5">
      {/* Header bar */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium text-gray-300">Last 50 alerts (refreshes every 10 s)</span>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-300 border border-indigo-700 rounded-lg hover:bg-indigo-900/30 disabled:opacity-50 transition-colors ml-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        {lastRefresh && (
          <span className="text-xs text-gray-500">
            Last refreshed {relativeTime(lastRefresh.toISOString())}
          </span>
        )}
      </div>

      {/* Reading counts per vehicle in last hour */}
      {counts.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Readings in Last Hour</p>
          <div className="flex flex-wrap gap-3">
            {counts.map((c) => (
              <div key={c.vehicle_id} className="flex items-center gap-2 bg-gray-800 rounded-lg px-3 py-1.5">
                <span className="text-sm text-white font-medium">{c.vehicle_name}</span>
                <span className="text-xs font-mono bg-indigo-900/60 text-indigo-300 px-2 py-0.5 rounded">
                  {c.count.toLocaleString()} readings
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Alerts table */}
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-900 border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Time</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Vehicle</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Sensor</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Value</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Severity</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {rows.map((r) => (
                <tr key={r.id} className={`${rowBg(r.severity)} hover:bg-gray-900/40 transition-colors`}>
                  <td className="px-4 py-3 text-xs font-mono text-gray-400 whitespace-nowrap">
                    {relativeTime(r.created_at)}
                  </td>
                  <td className="px-4 py-3 text-gray-200">{r.vehicle_name}</td>
                  <td className="px-4 py-3 font-mono text-indigo-300">{r.sensor_type}</td>
                  <td className="px-4 py-3 text-right font-mono text-white">{r.value}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      r.severity === 'critical'
                        ? 'bg-red-900/60 text-red-300 border border-red-700'
                        : r.severity === 'warning'
                        ? 'bg-yellow-900/60 text-yellow-300 border border-yellow-700'
                        : 'bg-gray-800 text-gray-400 border border-gray-700'
                    }`}>
                      {r.severity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-xs truncate">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-40 rounded-xl border border-dashed border-gray-700 text-gray-500">
          {loading
            ? <><RefreshCw className="w-7 h-7 mb-2 animate-spin opacity-40" /><p className="text-sm">Loading…</p></>
            : <><AlertCircle className="w-7 h-7 mb-2 opacity-40" /><p className="text-sm">No alerts recorded yet</p></>
          }
        </div>
      )}
    </div>
  );
}

// =============================================================================
// TAB 4 — Data Replay
// =============================================================================

function DataReplayTab() {
  const [vehicles,       setVehicles]       = useState<Vehicle[]>([]);
  const [selectedId,     setSelectedId]     = useState('');
  const [fromDate,       setFromDate]       = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 16);
  });
  const [toDate,         setToDate]         = useState(() => new Date().toISOString().slice(0, 16));
  const [selectedSensors, setSelectedSensors] = useState<Set<string>>(
    new Set(['rpm', 'speed', 'coolantTemp', 'fuelLevel', 'engineLoad'])
  );
  const [replayRows,     setReplayRows]     = useState<ReplayRow[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [loaded,         setLoaded]         = useState(false);

  useEffect(() => {
    supabase
      .from('vehicles')
      .select('id, name, vin, make, model, year, owner_id, fleet_id, is_active, health_score, last_connected, fuel_price_per_litre, avg_km_per_litre, created_at, updated_at')
      .order('name')
      .then(({ data }) => { if (data) setVehicles(data as Vehicle[]); });
  }, []);

  const toggleSensor = (s: string) => {
    setSelectedSensors((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };

  const loadData = async () => {
    if (!selectedId || selectedSensors.size === 0) return;
    setLoading(true);
    setLoaded(false);
    try {
      const { data, error } = await supabase
        .from('sensor_data')
        .select('id, timestamp, sensor_type, value, unit')
        .eq('vehicle_id', selectedId)
        .in('sensor_type', Array.from(selectedSensors))
        .gte('timestamp', new Date(fromDate).toISOString())
        .lte('timestamp', new Date(toDate).toISOString())
        .order('timestamp', { ascending: true })
        .limit(10001); // fetch one extra to detect overflow

      if (error) throw error;
      setReplayRows((data ?? []).slice(0, 10000) as ReplayRow[]);
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  };

  const isOverLimit = replayRows.length >= 10000;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        {/* Vehicle + date range row */}
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-400">Vehicle</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent min-w-[200px]"
            >
              <option value="">— select vehicle —</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>{v.name} ({v.vin})</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-400">From</label>
            <input
              type="datetime-local"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-gray-400">To</label>
            <input
              type="datetime-local"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-100 text-sm rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Sensor type checkboxes */}
        <div>
          <label className="text-xs font-medium text-gray-400 block mb-2">Sensor Types</label>
          <div className="flex flex-wrap gap-2">
            {REPLAY_SENSORS.map((s) => (
              <label
                key={s}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm cursor-pointer transition-colors ${
                  selectedSensors.has(s)
                    ? 'bg-indigo-900/50 border-indigo-600 text-indigo-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedSensors.has(s)}
                  onChange={() => toggleSensor(s)}
                  className="sr-only"
                />
                <span className="w-3.5 h-3.5 rounded border flex items-center justify-center text-xs
                  border-current">
                  {selectedSensors.has(s) && '✓'}
                </span>
                <span className="font-mono">{s}</span>
                <span className="text-xs opacity-60">{SENSOR_UNITS[s]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Load button */}
        <div className="flex items-center gap-4">
          <button
            onClick={loadData}
            disabled={loading || !selectedId || selectedSensors.size === 0}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            {loading
              ? <RefreshCw className="w-4 h-4 animate-spin" />
              : <Database className="w-4 h-4" />}
            {loading ? 'Loading…' : 'Load Data'}
          </button>

          {loaded && replayRows.length > 0 && (
            <button
              onClick={() => {
                const v = vehicles.find((x) => x.id === selectedId);
                exportCsv(replayRows, `replay_${v?.name ?? selectedId}_${fromDate.slice(0,10)}.csv`);
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-300 border border-emerald-700 rounded-lg hover:bg-emerald-900/30 transition-colors"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          )}

          {loaded && (
            <span className="text-sm text-gray-400">
              {replayRows.length.toLocaleString()} record{replayRows.length !== 1 ? 's' : ''} loaded
            </span>
          )}
        </div>
      </div>

      {/* Over-limit warning */}
      {isOverLimit && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-yellow-950/40 border border-yellow-700 text-yellow-300 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>
            Result was capped at 10,000 rows. Narrow your date range or select fewer sensor types
            to see the full dataset.
          </span>
        </div>
      )}

      {/* Results table */}
      {loaded && replayRows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-900 border-b border-gray-800">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Timestamp</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Sensor Type</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Value</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {replayRows.map((r) => (
                <tr key={r.id} className="hover:bg-gray-900/40 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-gray-400 whitespace-nowrap">
                    {new Date(r.timestamp).toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-indigo-300">{r.sensor_type}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-white">
                    {typeof r.value === 'number' ? r.value.toFixed(2) : r.value}
                  </td>
                  <td className="px-4 py-2.5 text-gray-400">{r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loaded && replayRows.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center h-40 rounded-xl border border-dashed border-gray-700 text-gray-500">
          <Database className="w-7 h-7 mb-2 opacity-40" />
          <p className="text-sm">No records found for the selected criteria</p>
        </div>
      )}

      {!loaded && !loading && (
        <div className="flex flex-col items-center justify-center h-40 rounded-xl border border-dashed border-gray-700 text-gray-500">
          <Eye className="w-7 h-7 mb-2 opacity-40" />
          <p className="text-sm">Configure the filters above and click "Load Data"</p>
        </div>
      )}
    </div>
  );
}

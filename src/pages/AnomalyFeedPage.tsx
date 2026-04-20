import { useState, useEffect, useMemo } from 'react';
import { Activity, AlertTriangle, Zap, TrendingDown, Eye, Filter } from 'lucide-react';
import { supabase, type Vehicle, type Alert } from '../lib/supabase';

const BEHAVIOR_SENSOR_TYPES = new Set([
  'rpm',
  'speed',
  'throttlePosition',
  'engineLoad',
  'harshBraking',
  'harshAcceleration',
]);

function isBehaviorAnomaly(alert: Alert): boolean {
  return BEHAVIOR_SENSOR_TYPES.has(alert.sensor_type) || alert.severity === 'critical';
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
}

function getDateGroup(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const alertDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (alertDay.getTime() === today.getTime()) return 'Today';
  if (alertDay.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

const SENSOR_LABELS: Record<string, string> = {
  rpm: 'Engine RPM',
  speed: 'Vehicle Speed',
  throttlePosition: 'Throttle Position',
  engineLoad: 'Engine Load',
  harshBraking: 'Harsh Braking',
  harshAcceleration: 'Harsh Acceleration',
  coolantTemp: 'Coolant Temp',
  fuelLevel: 'Fuel Level',
  battery: 'Battery',
  oilTemp: 'Oil Temp',
};

function getSensorLabel(sensorType: string): string {
  return SENSOR_LABELS[sensorType] ?? sensorType;
}

function SensorIcon({ sensorType }: { sensorType: string }) {
  if (sensorType === 'rpm' || sensorType === 'throttlePosition') {
    return <Zap className="w-4 h-4 text-yellow-400" />;
  }
  if (sensorType === 'harshBraking' || sensorType === 'speed') {
    return <TrendingDown className="w-4 h-4 text-red-400" />;
  }
  return <AlertTriangle className="w-4 h-4 text-orange-400" />;
}

const severityBadgeClass: Record<Alert['severity'], string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
  warning: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  info: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
};

const severityDotClass: Record<Alert['severity'], string> = {
  critical: 'bg-red-500',
  warning: 'bg-yellow-500',
  info: 'bg-blue-500',
};

export default function AnomalyFeedPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [vehicleFilter, setVehicleFilter] = useState<string>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | Alert['severity']>('all');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const [alertsRes, vehiclesRes] = await Promise.all([
        supabase
          .from('alerts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500),
        supabase.from('vehicles').select('*'),
      ]);

      if (alertsRes.data) setAlerts(alertsRes.data);
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
    } catch (error) {
      console.error('Error loading anomaly feed:', error);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  };

  const vehicleMap = useMemo(
    () =>
      vehicles.reduce<Record<string, Vehicle>>((acc, v) => {
        acc[v.id] = v;
        return acc;
      }, {}),
    [vehicles]
  );

  // Base filter: behavior only or all
  const baseAlerts = useMemo(
    () => (showAllAlerts ? alerts : alerts.filter(isBehaviorAnomaly)),
    [alerts, showAllAlerts]
  );

  // 24-hour window stats
  const last24hCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const alerts24h = alerts.filter(a => new Date(a.created_at).getTime() > last24hCutoff);
  const criticalCount24h = alerts24h.filter(a => a.severity === 'critical').length;
  const warningCount24h = alerts24h.filter(a => a.severity === 'warning').length;
  const vehiclesAffected = new Set(alerts24h.map(a => a.vehicle_id)).size;

  // Apply filters
  const filteredAlerts = useMemo(() => {
    let result = baseAlerts;
    if (vehicleFilter !== 'all') {
      result = result.filter(a => a.vehicle_id === vehicleFilter);
    }
    if (severityFilter !== 'all') {
      result = result.filter(a => a.severity === severityFilter);
    }
    return result;
  }, [baseAlerts, vehicleFilter, severityFilter]);

  // Group by date
  const groupedAlerts = useMemo(() => {
    const groups = new Map<string, Alert[]>();
    for (const alert of filteredAlerts) {
      const group = getDateGroup(alert.created_at);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(alert);
    }
    return Array.from(groups.entries());
  }, [filteredAlerts]);

  // Sensor type summary for bottom section (all alerts, no filter)
  const sensorTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const alert of baseAlerts) {
      counts[alert.sensor_type] = (counts[alert.sensor_type] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [baseAlerts]);

  const maxSensorCount = sensorTypeCounts.length > 0 ? sensorTypeCounts[0][1] : 1;

  // Vehicles that actually have alerts in the base set
  const vehiclesWithAlerts = useMemo(() => {
    const ids = new Set(baseAlerts.map(a => a.vehicle_id));
    return vehicles.filter(v => ids.has(v.id));
  }, [baseAlerts, vehicles]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Anomaly Feed</h1>
          <p className="text-gray-400">
            Driver behaviour events and sensor anomaly timeline
          </p>
        </div>
        <button
          onClick={() => setShowAllAlerts(prev => !prev)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
            showAllAlerts
              ? 'bg-blue-600 border-blue-500 text-white hover:bg-blue-700'
              : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white'
          }`}
        >
          <Eye className="w-4 h-4" />
          {showAllAlerts ? 'Showing All Alerts' : 'Behavior Only'}
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Anomalies (24h)',
            value: alerts24h.length,
            icon: Activity,
            color: 'text-blue-500',
            bg: 'bg-blue-500/20',
          },
          {
            label: 'Critical (24h)',
            value: criticalCount24h,
            icon: AlertTriangle,
            color: 'text-red-500',
            bg: 'bg-red-500/20',
          },
          {
            label: 'Warnings (24h)',
            value: warningCount24h,
            icon: Filter,
            color: 'text-yellow-500',
            bg: 'bg-yellow-500/20',
          },
          {
            label: 'Vehicles Affected',
            value: vehiclesAffected,
            icon: Zap,
            color: 'text-purple-500',
            bg: 'bg-purple-500/20',
          },
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

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 bg-gray-900 rounded-lg border border-gray-800 p-4">
        <span className="text-sm text-gray-400 font-medium flex items-center gap-2">
          <Filter className="w-4 h-4" /> Filters:
        </span>

        {/* Vehicle filter */}
        <select
          value={vehicleFilter}
          onChange={e => setVehicleFilter(e.target.value)}
          className="bg-gray-800 text-gray-300 text-sm border border-gray-700 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        >
          <option value="all">All Vehicles</option>
          {vehiclesWithAlerts.map(v => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>

        {/* Severity filter */}
        <div className="flex items-center gap-1">
          {(['all', 'critical', 'warning', 'info'] as const).map(sev => (
            <button
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                severityFilter === sev
                  ? sev === 'all'
                    ? 'bg-blue-600 text-white'
                    : sev === 'critical'
                    ? 'bg-red-600 text-white'
                    : sev === 'warning'
                    ? 'bg-yellow-600 text-white'
                    : 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
              }`}
            >
              {sev}
            </button>
          ))}
        </div>

        {filteredAlerts.length !== baseAlerts.length && (
          <span className="text-xs text-gray-500 ml-auto">
            Showing {filteredAlerts.length} of {baseAlerts.length} events
          </span>
        )}
      </div>

      {/* Timeline Feed */}
      {filteredAlerts.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <Activity className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg font-medium">No anomalies found</p>
          <p className="text-gray-600 text-sm mt-2">
            {showAllAlerts
              ? 'No alerts match the current filters.'
              : 'No behaviour anomalies detected. Try switching to "Showing All Alerts" to see all events.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groupedAlerts.map(([dateGroup, groupAlerts]) => (
            <div key={dateGroup}>
              {/* Date group header */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-sm font-semibold text-gray-300">{dateGroup}</span>
                <div className="flex-1 h-px bg-gray-800" />
                <span className="text-xs text-gray-600">{groupAlerts.length} event{groupAlerts.length !== 1 ? 's' : ''}</span>
              </div>

              {/* Alert cards */}
              <div className="space-y-2">
                {groupAlerts.map(alert => {
                  const vehicle = vehicleMap[alert.vehicle_id];
                  return (
                    <div
                      key={alert.id}
                      className="bg-gray-900 rounded-lg border border-gray-800 px-5 py-4 flex items-start gap-4 hover:border-gray-700 transition-colors"
                    >
                      {/* Severity dot */}
                      <div className="flex-shrink-0 mt-1">
                        <span
                          className={`w-2.5 h-2.5 rounded-full block ${severityDotClass[alert.severity]}`}
                        />
                      </div>

                      {/* Sensor icon */}
                      <div className="flex-shrink-0 mt-0.5">
                        <SensorIcon sensorType={alert.sensor_type} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-white font-medium text-sm">
                            {getSensorLabel(alert.sensor_type)}
                          </span>
                          {alert.value != null && (
                            <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded font-mono">
                              {getSensorLabel(alert.sensor_type)}: {alert.value}
                            </span>
                          )}
                          <span
                            className={`text-xs font-medium px-2 py-0.5 rounded-full capitalize ${severityBadgeClass[alert.severity]}`}
                          >
                            {alert.severity}
                          </span>
                        </div>
                        <p className="text-sm text-gray-400 leading-relaxed">{alert.message}</p>
                        <div className="flex flex-wrap items-center gap-3 mt-1.5">
                          <span className="text-xs text-gray-500">
                            {vehicle ? vehicle.name : 'Unknown Vehicle'}
                            {vehicle && (
                              <span className="text-gray-700">
                                {' '}
                                · {vehicle.make} {vehicle.model}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-gray-600">
                            {timeAgo(alert.created_at)}
                          </span>
                          <span className="text-xs text-gray-700">
                            {new Date(alert.created_at).toLocaleTimeString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Sensor Anomaly Summary */}
      {sensorTypeCounts.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="inline-flex p-2 rounded-lg bg-blue-500/20">
              <BarChartIcon />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">Sensor Anomaly Summary</h2>
              <p className="text-sm text-gray-400">Anomaly count per sensor type</p>
            </div>
          </div>
          <div className="space-y-3">
            {sensorTypeCounts.map(([sensorType, count]) => {
              const pct = Math.round((count / maxSensorCount) * 100);
              return (
                <div key={sensorType}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-gray-300 font-medium">
                      {getSensorLabel(sensorType)}
                    </span>
                    <span className="text-sm text-gray-400 tabular-nums">{count}</span>
                  </div>
                  <div className="h-2.5 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Inline icon to avoid importing BarChart2 alongside the named imports
function BarChartIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-blue-500"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

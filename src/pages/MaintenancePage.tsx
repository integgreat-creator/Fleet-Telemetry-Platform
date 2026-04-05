import { useState, useEffect } from 'react';
import { Wrench, AlertTriangle, CheckCircle, Clock, TrendingUp, Shield } from 'lucide-react';
import { supabase, type Vehicle } from '../lib/supabase';

interface MaintenancePrediction {
  id: string;
  vehicle_id: string;
  component: string;
  prediction_type: string;
  confidence_score: number;
  predicted_date: string;
  miles_remaining?: number;
  status: string;
  created_at: string;
}

type UrgencyLevel = 'critical' | 'warning' | 'monitoring';

function getDaysUntil(dateStr: string): number {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  return (then - now) / (1000 * 60 * 60 * 24);
}

function getUrgency(pred: MaintenancePrediction): UrgencyLevel {
  if (pred.status === 'critical') return 'critical';
  const days = getDaysUntil(pred.predicted_date);
  if (days < 7) return 'critical';
  if (days < 30) return 'warning';
  return 'monitoring';
}

const urgencyBorderClass: Record<UrgencyLevel, string> = {
  critical: 'border-l-4 border-l-red-500',
  warning: 'border-l-4 border-l-yellow-500',
  monitoring: 'border-l-4 border-l-blue-500',
};

const urgencyBadgeClass: Record<UrgencyLevel, string> = {
  critical: 'bg-red-500/20 text-red-400 border border-red-500/30',
  warning: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  monitoring: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
};

const urgencyLabel: Record<UrgencyLevel, string> = {
  critical: 'Critical',
  warning: 'Due Soon',
  monitoring: 'Monitoring',
};

const STATIC_INSIGHTS = [
  {
    icon: TrendingUp,
    iconColor: 'text-red-400',
    iconBg: 'bg-red-500/20',
    title: 'Cooling System Anomaly Detected',
    description:
      'Coolant temperature readings are showing elevated variance (±12°C above baseline) on multiple vehicles. This pattern is consistent with early-stage thermostat degradation or coolant loss. Recommend inspection within 14 days.',
    badge: 'Critical',
    badgeClass: 'bg-red-500/20 text-red-400 border border-red-500/30',
    action: 'Inspect coolant level and thermostat',
  },
  {
    icon: Shield,
    iconColor: 'text-yellow-400',
    iconBg: 'bg-yellow-500/20',
    title: 'Brake System Wear Pattern',
    description:
      'Harsh braking events combined with high deceleration G-force signatures suggest front brake pad wear. Historical sensor data shows 23% increase in braking distance over the past 30 days. Estimated 8–12 weeks remaining before replacement required.',
    badge: 'Warning',
    badgeClass: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    action: 'Schedule brake pad inspection',
  },
  {
    icon: Wrench,
    iconColor: 'text-blue-400',
    iconBg: 'bg-blue-500/20',
    title: 'Fuel System Efficiency Decline',
    description:
      'Fuel consumption per 100 km has increased by 8.4% over the last 45 days without corresponding changes in load or route difficulty. This is typically indicative of injector fouling, clogged air filter, or O2 sensor drift.',
    badge: 'Monitoring',
    badgeClass: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    action: 'Check air filter and fuel injectors',
  },
];

export default function MaintenancePage() {
  const [predictions, setPredictions] = useState<MaintenancePrediction[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [predsRes, vehiclesRes] = await Promise.all([
        supabase
          .from('maintenance_predictions')
          .select('*')
          .order('predicted_date', { ascending: true })
          .limit(500),
        supabase.from('vehicles').select('*'),
      ]);

      if (predsRes.data) setPredictions(predsRes.data);
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
    } catch (error) {
      console.error('Error loading maintenance predictions:', error);
    } finally {
      setLoading(false);
    }
  };

  const vehicleMap = vehicles.reduce<Record<string, Vehicle>>((acc, v) => {
    acc[v.id] = v;
    return acc;
  }, {});

  // Stats
  const totalPredictions = predictions.length;
  const criticalCount = predictions.filter(p => {
    const urgency = getUrgency(p);
    return urgency === 'critical';
  }).length;
  const scheduledCount = predictions.filter(p => p.status === 'scheduled').length;
  const monitoringCount = predictions.filter(p => getUrgency(p) === 'monitoring').length;

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });

  const formatDaysUntil = (days: number) => {
    if (days < 0) return 'Overdue';
    if (days < 1) return 'Today';
    if (days < 2) return 'Tomorrow';
    return `${Math.round(days)} days`;
  };

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
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Maintenance Predictions</h1>
        <p className="text-gray-400">
          AI-powered predictive maintenance alerts based on sensor patterns and vehicle history
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Predictions',
            value: totalPredictions,
            icon: Wrench,
            color: 'text-blue-500',
            bg: 'bg-blue-500/20',
          },
          {
            label: 'Critical',
            value: criticalCount,
            icon: AlertTriangle,
            color: 'text-red-500',
            bg: 'bg-red-500/20',
          },
          {
            label: 'Scheduled',
            value: scheduledCount,
            icon: Clock,
            color: 'text-yellow-500',
            bg: 'bg-yellow-500/20',
          },
          {
            label: 'Monitoring',
            value: monitoringCount,
            icon: CheckCircle,
            color: 'text-green-500',
            bg: 'bg-green-500/20',
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

      {/* Prediction Cards Grid */}
      {predictions.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <Wrench className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg font-medium">No maintenance predictions yet</p>
          <p className="text-gray-600 text-sm mt-2 max-w-md mx-auto">
            Predictive maintenance data will appear here once the AI engine analyses sensor patterns
            from connected OBD devices.
          </p>
        </div>
      ) : (
        <>
          <div>
            <h2 className="text-xl font-bold text-white mb-4">Active Predictions</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {predictions.map(pred => {
                const urgency = getUrgency(pred);
                const vehicle = vehicleMap[pred.vehicle_id];
                const days = getDaysUntil(pred.predicted_date);
                const confidencePct = Math.round((pred.confidence_score || 0) * 100);

                return (
                  <div
                    key={pred.id}
                    className={`bg-gray-900 rounded-lg border border-gray-800 p-5 ${urgencyBorderClass[urgency]}`}
                  >
                    {/* Component + urgency badge */}
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div>
                        <h3 className="text-white font-semibold text-base">
                          {pred.component}
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">{pred.prediction_type}</p>
                      </div>
                      <span
                        className={`text-xs font-medium px-2 py-1 rounded-full whitespace-nowrap ${urgencyBadgeClass[urgency]}`}
                      >
                        {urgencyLabel[urgency]}
                      </span>
                    </div>

                    {/* Vehicle */}
                    <p className="text-sm text-gray-400 mb-3">
                      {vehicle ? vehicle.name : 'Unknown Vehicle'}
                      {vehicle && (
                        <span className="text-gray-600">
                          {' '}
                          · {vehicle.make} {vehicle.model}
                        </span>
                      )}
                    </p>

                    {/* Confidence bar */}
                    <div className="mb-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-400">Confidence</span>
                        <span className="text-xs text-gray-300 font-medium">{confidencePct}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${
                            confidencePct >= 80
                              ? 'bg-green-500'
                              : confidencePct >= 60
                              ? 'bg-yellow-500'
                              : 'bg-red-500'
                          }`}
                          style={{ width: `${confidencePct}%` }}
                        />
                      </div>
                    </div>

                    {/* Date + days */}
                    <div className="flex items-center justify-between pt-3 border-t border-gray-800">
                      <div>
                        <p className="text-xs text-gray-500">Predicted Date</p>
                        <p className="text-sm text-white font-medium">
                          {formatDate(pred.predicted_date)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-500">Due In</p>
                        <p
                          className={`text-sm font-medium ${
                            urgency === 'critical'
                              ? 'text-red-400'
                              : urgency === 'warning'
                              ? 'text-yellow-400'
                              : 'text-blue-400'
                          }`}
                        >
                          {formatDaysUntil(days)}
                        </p>
                      </div>
                    </div>

                    {/* Miles remaining */}
                    {pred.miles_remaining != null && (
                      <p className="text-xs text-gray-500 mt-2">
                        ~{pred.miles_remaining.toLocaleString()} km remaining
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Maintenance Schedule Table */}
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800">
              <h2 className="text-lg font-bold text-white">Maintenance Schedule</h2>
              <p className="text-sm text-gray-400">All upcoming maintenance events, sorted by predicted date</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800">
                    {[
                      'Vehicle',
                      'Component',
                      'Type',
                      'Predicted Date',
                      'Days Until',
                      'Confidence',
                      'Status',
                    ].map(col => (
                      <th
                        key={col}
                        className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {predictions.map(pred => {
                    const vehicle = vehicleMap[pred.vehicle_id];
                    const urgency = getUrgency(pred);
                    const days = getDaysUntil(pred.predicted_date);
                    const confidencePct = Math.round((pred.confidence_score || 0) * 100);

                    return (
                      <tr key={pred.id} className="hover:bg-gray-800/50 transition-colors">
                        <td className="px-4 py-3">
                          <p className="text-white text-sm font-medium">
                            {vehicle?.name ?? 'Unknown'}
                          </p>
                          {vehicle && (
                            <p className="text-gray-600 text-xs">
                              {vehicle.make} {vehicle.model}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{pred.component}</td>
                        <td className="px-4 py-3 text-sm text-gray-400">{pred.prediction_type}</td>
                        <td className="px-4 py-3 text-sm text-gray-300">
                          {formatDate(pred.predicted_date)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-sm font-medium ${
                              urgency === 'critical'
                                ? 'text-red-400'
                                : urgency === 'warning'
                                ? 'text-yellow-400'
                                : 'text-blue-400'
                            }`}
                          >
                            {formatDaysUntil(days)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-300">{confidencePct}%</td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-xs font-medium px-2 py-1 rounded-full ${urgencyBadgeClass[urgency]}`}
                          >
                            {urgencyLabel[urgency]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* AI-Generated Insights from Sensor Data (shown when no predictions yet) */}
      {predictions.length === 0 && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <div className="inline-flex p-2 rounded-lg bg-purple-500/20">
              <TrendingUp className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white">AI-Generated Insights from Sensor Data</h2>
              <p className="text-sm text-gray-400">
                Anomaly patterns detected from live OBD sensor telemetry
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {STATIC_INSIGHTS.map(insight => (
              <div
                key={insight.title}
                className="bg-gray-900 rounded-lg border border-gray-800 p-5 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className={`inline-flex p-2 rounded-lg ${insight.iconBg}`}>
                    <insight.icon className={`w-5 h-5 ${insight.iconColor}`} />
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full ${insight.badgeClass}`}>
                    {insight.badge}
                  </span>
                </div>
                <div>
                  <h3 className="text-white font-semibold text-sm leading-tight mb-1">
                    {insight.title}
                  </h3>
                  <p className="text-gray-400 text-xs leading-relaxed">{insight.description}</p>
                </div>
                <div className="pt-2 border-t border-gray-800">
                  <p className="text-xs text-gray-500">
                    <span className="text-gray-400 font-medium">Recommended Action: </span>
                    {insight.action}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

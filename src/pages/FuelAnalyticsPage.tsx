import { useState, useEffect } from 'react';
import { Fuel, TrendingDown, AlertTriangle, CheckCircle, Zap, ChevronRight } from 'lucide-react';
import { supabase, type Vehicle, type CostInsight } from '../lib/supabase';

interface VehicleFuelStats {
  vehicle: Vehicle;
  insights: CostInsight[];
  avgKmPerLitre: number;
  maxKmPerLitre: number;
}

export default function FuelAnalyticsPage() {
  const [insights, setInsights] = useState<CostInsight[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    try {
      const [insightsRes, vehiclesRes] = await Promise.all([
        supabase
          .from('cost_insights')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase.from('vehicles').select('*'),
      ]);

      if (insightsRes.data) setInsights(insightsRes.data);
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
    } catch (error) {
      console.error('Error loading fuel analytics:', error);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  };

  const handleResolve = async (insightId: string) => {
    setResolvingId(insightId);
    try {
      const { error } = await supabase
        .from('cost_insights')
        .update({ is_resolved: true })
        .eq('id', insightId);

      if (!error) {
        setInsights(prev =>
          prev.map(i => i.id === insightId ? { ...i, is_resolved: true } : i)
        );
      }
    } catch (error) {
      console.error('Error resolving insight:', error);
    } finally {
      setResolvingId(null);
    }
  };

  // Compute stats
  const totalInsights = insights.length;
  const totalSavings = insights.reduce((s, i) => s + (i.potential_savings || 0), 0);
  const unresolvedCount = insights.filter(i => !i.is_resolved).length;
  const criticalCount = insights.filter(i => i.severity === 'critical' && !i.is_resolved).length;

  // Group insights by vehicle
  const vehicleStats: VehicleFuelStats[] = vehicles.map(vehicle => {
    const vehicleInsights = insights.filter(i => i.vehicle_id === vehicle.id);
    return {
      vehicle,
      insights: vehicleInsights,
      avgKmPerLitre: vehicle.avg_km_per_litre || 0,
      maxKmPerLitre: 20, // Theoretical max for bar chart scaling
    };
  }).filter(vs => vs.insights.length > 0 || vs.avgKmPerLitre > 0);

  // Fleet-wide max for bar scaling
  const fleetMax = Math.max(...vehicleStats.map(vs => vs.avgKmPerLitre), 1);

  const severityConfig = {
    critical: { label: 'Critical', classes: 'bg-red-500/20 text-red-400 border border-red-500/30' },
    warning: { label: 'Warning', classes: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' },
    info: { label: 'Info', classes: 'bg-blue-500/20 text-blue-400 border border-blue-500/30' },
  };

  const typeLabels: Record<string, string> = {
    fuel_prediction: 'Fuel Prediction',
    idle_waste: 'Idle Waste',
    harsh_driving: 'Harsh Driving',
    maintenance: 'Maintenance',
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
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Fuel Analytics</h1>
        <p className="text-gray-400">AI-generated fuel efficiency insights and cost-saving opportunities</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Insights',
            value: totalInsights,
            icon: Zap,
            color: 'text-blue-500',
            bg: 'bg-blue-500/20',
          },
          {
            label: 'Potential Savings',
            value: `₹${totalSavings.toLocaleString('en-IN')}`,
            icon: TrendingDown,
            color: 'text-green-500',
            bg: 'bg-green-500/20',
          },
          {
            label: 'Unresolved',
            value: unresolvedCount,
            icon: AlertTriangle,
            color: 'text-yellow-500',
            bg: 'bg-yellow-500/20',
          },
          {
            label: 'Critical Alerts',
            value: criticalCount,
            icon: Fuel,
            color: 'text-red-500',
            bg: 'bg-red-500/20',
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

      {/* Per-vehicle fuel efficiency bar chart */}
      {vehicleStats.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
          <h2 className="text-xl font-bold text-white mb-5">Fleet Fuel Efficiency</h2>
          <div className="space-y-4">
            {vehicleStats.map(vs => {
              const pct = fleetMax > 0 ? (vs.avgKmPerLitre / fleetMax) * 100 : 0;
              const barColor =
                vs.avgKmPerLitre >= 14
                  ? 'bg-green-500'
                  : vs.avgKmPerLitre >= 10
                  ? 'bg-yellow-500'
                  : 'bg-red-500';
              return (
                <div key={vs.vehicle.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm text-white font-medium">{vs.vehicle.name}</span>
                    <span className="text-sm text-gray-400">
                      {vs.avgKmPerLitre.toFixed(1)} km/L
                    </span>
                  </div>
                  <div className="h-3 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-6 mt-5 pt-4 border-t border-gray-800">
            {[
              { color: 'bg-green-500', label: 'Efficient (≥14 km/L)' },
              { color: 'bg-yellow-500', label: 'Average (10–14 km/L)' },
              { color: 'bg-red-500', label: 'Poor (<10 km/L)' },
            ].map(l => (
              <div key={l.label} className="flex items-center gap-2">
                <span className={`w-3 h-3 rounded-full ${l.color}`} />
                <span className="text-xs text-gray-400">{l.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Insights grouped by vehicle */}
      {insights.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <Fuel className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg">No fuel insights generated yet</p>
          <p className="text-gray-600 text-sm mt-2">
            Run the AI intelligence engine to detect inefficiencies and generate insights
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {vehicles
            .filter(v => insights.some(i => i.vehicle_id === v.id))
            .map(vehicle => {
              const vehicleInsights = insights.filter(i => i.vehicle_id === vehicle.id);
              const unresolvedVehicle = vehicleInsights.filter(i => !i.is_resolved).length;
              return (
                <div key={vehicle.id} className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
                  {/* Vehicle header */}
                  <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
                    <div className="flex items-center gap-3">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <h3 className="text-white font-semibold">{vehicle.name}</h3>
                      <span className="text-xs text-gray-500">
                        {vehicle.make} {vehicle.model} · {vehicle.year}
                      </span>
                    </div>
                    {unresolvedVehicle > 0 && (
                      <span className="text-xs font-medium px-2 py-1 rounded-full bg-yellow-500/20 text-yellow-400">
                        {unresolvedVehicle} unresolved
                      </span>
                    )}
                  </div>

                  {/* Insights list */}
                  <div className="divide-y divide-gray-800">
                    {vehicleInsights.map(insight => {
                      const sev = severityConfig[insight.severity] ?? severityConfig.info;
                      return (
                        <div
                          key={insight.id}
                          className={`px-5 py-4 flex items-start justify-between gap-4 transition-opacity ${
                            insight.is_resolved ? 'opacity-50' : ''
                          }`}
                        >
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className="flex-shrink-0 mt-0.5">
                              {insight.is_resolved ? (
                                <CheckCircle className="w-4 h-4 text-green-500" />
                              ) : insight.severity === 'critical' ? (
                                <AlertTriangle className="w-4 h-4 text-red-400" />
                              ) : (
                                <ChevronRight className="w-4 h-4 text-yellow-400" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${sev.classes}`}>
                                  {sev.label}
                                </span>
                                <span className="text-xs text-gray-500">
                                  {typeLabels[insight.type] ?? insight.type}
                                </span>
                                <span className="text-xs text-gray-600">
                                  {new Date(insight.created_at).toLocaleDateString('en-IN', {
                                    day: '2-digit',
                                    month: 'short',
                                    year: 'numeric',
                                  })}
                                </span>
                              </div>
                              <p className="text-sm text-gray-300 leading-relaxed">{insight.message}</p>
                              {insight.potential_savings > 0 && (
                                <p className="text-xs text-green-400 mt-1 font-medium">
                                  Potential savings: ₹{insight.potential_savings.toLocaleString('en-IN')}
                                </p>
                              )}
                            </div>
                          </div>
                          {!insight.is_resolved && (
                            <button
                              onClick={() => handleResolve(insight.id)}
                              disabled={resolvingId === insight.id}
                              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {resolvingId === insight.id ? 'Saving…' : 'Resolve'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from 'react';
import { DollarSign, TrendingUp, TrendingDown, BarChart2, RefreshCw, AlertCircle } from 'lucide-react';
import { supabase, type Vehicle, type CostInsight } from '../lib/supabase';

interface CostPrediction {
  id: string;
  vehicle_id: string;
  forecast_period: string;
  estimated_fuel_cost: number;
  estimated_maintenance_cost: number;
  estimated_insurance_cost: number;
  estimated_total_cost: number;
  confidence_score: number;
  factors: {
    driving_impact: string;
    historical_trend: string;
  };
  created_at: string;
}

export default function CostAnalyticsPage() {
  const [predictions, setPredictions] = useState<CostPrediction[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [costInsights, setCostInsights] = useState<CostInsight[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    const timeout = setTimeout(() => { setLoading(false); setRefreshing(false); }, 8000);
    try {
      const [predictionsRes, vehiclesRes, insightsRes] = await Promise.all([
        supabase
          .from('cost_predictions')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500),
        supabase.from('vehicles').select('*'),
        supabase
          .from('cost_insights')
          .select('*')
          .eq('is_resolved', false)
          .order('created_at', { ascending: false }),
      ]);

      if (predictionsRes.data) setPredictions(predictionsRes.data);
      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
      if (insightsRes.data) setCostInsights(insightsRes.data);
    } catch (error) {
      console.error('Error loading cost analytics:', error);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadData();
  };

  // Latest prediction per vehicle
  const latestPerVehicle = predictions.reduce<Record<string, CostPrediction>>((acc, pred) => {
    if (!acc[pred.vehicle_id] || pred.created_at > acc[pred.vehicle_id].created_at) {
      acc[pred.vehicle_id] = pred;
    }
    return acc;
  }, {});

  const latestPredictions = Object.values(latestPerVehicle).sort(
    (a, b) => b.estimated_total_cost - a.estimated_total_cost
  );

  const vehicleMap = vehicles.reduce<Record<string, Vehicle>>((acc, v) => {
    acc[v.id] = v;
    return acc;
  }, {});

  // Stats
  const totalMonthlyForecast = latestPredictions.reduce(
    (sum, p) => sum + (p.estimated_total_cost || 0),
    0
  );
  const avgFuelCost =
    latestPredictions.length > 0
      ? latestPredictions.reduce((sum, p) => sum + (p.estimated_fuel_cost || 0), 0) /
        latestPredictions.length
      : 0;
  const avgMaintenanceCost =
    latestPredictions.length > 0
      ? latestPredictions.reduce((sum, p) => sum + (p.estimated_maintenance_cost || 0), 0) /
        latestPredictions.length
      : 0;
  const avgConfidence =
    latestPredictions.length > 0
      ? latestPredictions.reduce((sum, p) => sum + (p.confidence_score || 0), 0) /
        latestPredictions.length
      : 0;

  const confidenceBadge = (score: number) => {
    if (score >= 0.8)
      return {
        label: 'High Confidence',
        classes: 'bg-green-500/20 text-green-400 border border-green-500/30',
      };
    if (score >= 0.6)
      return {
        label: 'Medium',
        classes: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
      };
    return {
      label: 'Low',
      classes: 'bg-red-500/20 text-red-400 border border-red-500/30',
    };
  };

  const formatCurrency = (value: number) =>
    `₹${Math.round(value).toLocaleString('en-IN')}`;

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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Cost Analytics</h1>
          <p className="text-gray-400">
            AI-generated cost forecasts and expense breakdowns per vehicle
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg border border-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[
          {
            label: 'Total Monthly Forecast',
            value: formatCurrency(totalMonthlyForecast),
            icon: DollarSign,
            color: 'text-blue-500',
            bg: 'bg-blue-500/20',
            sub: `${latestPredictions.length} vehicles`,
          },
          {
            label: 'Avg Fuel Cost',
            value: formatCurrency(avgFuelCost),
            icon: TrendingUp,
            color: 'text-orange-500',
            bg: 'bg-orange-500/20',
            sub: 'per vehicle / month',
          },
          {
            label: 'Avg Maintenance Cost',
            value: formatCurrency(avgMaintenanceCost),
            icon: BarChart2,
            color: 'text-purple-500',
            bg: 'bg-purple-500/20',
            sub: 'per vehicle / month',
          },
          {
            label: 'Avg Confidence',
            value: `${Math.round(avgConfidence * 100)}%`,
            icon: TrendingDown,
            color: avgConfidence >= 0.8 ? 'text-green-500' : avgConfidence >= 0.6 ? 'text-yellow-500' : 'text-red-500',
            bg: avgConfidence >= 0.8 ? 'bg-green-500/20' : avgConfidence >= 0.6 ? 'bg-yellow-500/20' : 'bg-red-500/20',
            sub: 'forecast accuracy',
          },
        ].map(s => (
          <div key={s.label} className="bg-gray-900 rounded-lg p-5 border border-gray-800">
            <div className={`inline-flex p-2 rounded-lg ${s.bg} mb-3`}>
              <s.icon className={`w-5 h-5 ${s.color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{s.value}</p>
            <p className="text-sm text-gray-400">{s.label}</p>
            {s.sub && <p className="text-xs text-gray-600 mt-0.5">{s.sub}</p>}
          </div>
        ))}
      </div>

      {/* Per-vehicle cost breakdown */}
      {latestPredictions.length === 0 ? (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-16 text-center">
          <AlertCircle className="w-16 h-16 text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 text-lg font-medium">No cost predictions available</p>
          <p className="text-gray-600 text-sm mt-2 max-w-md mx-auto">
            Cost forecasts are generated automatically once your vehicles are connected via an OBD
            device and sensor data starts flowing in. Make sure your OBD device is paired and
            transmitting data.
          </p>
        </div>
      ) : (
        <div>
          <h2 className="text-xl font-bold text-white mb-4">Per-Vehicle Cost Breakdown</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {latestPredictions.map(pred => {
              const vehicle = vehicleMap[pred.vehicle_id];
              const totalCost = pred.estimated_total_cost || 1;
              const fuelPct = Math.round((pred.estimated_fuel_cost / totalCost) * 100);
              const mainPct = Math.round((pred.estimated_maintenance_cost / totalCost) * 100);
              const insPct = Math.round((pred.estimated_insurance_cost / totalCost) * 100);
              const badge = confidenceBadge(pred.confidence_score);

              return (
                <div
                  key={pred.id}
                  className="bg-gray-900 rounded-lg border border-gray-800 p-5 space-y-4"
                >
                  {/* Vehicle name + confidence badge */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="text-white font-semibold text-base leading-tight">
                        {vehicle?.name ?? 'Unknown Vehicle'}
                      </h3>
                      {vehicle && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          {vehicle.make} {vehicle.model} · {vehicle.year}
                        </p>
                      )}
                    </div>
                    <span className={`text-xs font-medium px-2 py-1 rounded-full whitespace-nowrap ${badge.classes}`}>
                      {badge.label}
                    </span>
                  </div>

                  {/* Total cost */}
                  <div>
                    <p className="text-3xl font-bold text-white">
                      {formatCurrency(pred.estimated_total_cost)}
                    </p>
                    <p className="text-xs text-gray-500">
                      {pred.forecast_period || 'Monthly forecast'}
                    </p>
                  </div>

                  {/* Cost bars */}
                  <div className="space-y-3">
                    {/* Fuel */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-400">Fuel</span>
                        <span className="text-xs text-gray-300 font-medium">
                          {formatCurrency(pred.estimated_fuel_cost)}{' '}
                          <span className="text-gray-600">({fuelPct}%)</span>
                        </span>
                      </div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${fuelPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Maintenance */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-400">Maintenance</span>
                        <span className="text-xs text-gray-300 font-medium">
                          {formatCurrency(pred.estimated_maintenance_cost)}{' '}
                          <span className="text-gray-600">({mainPct}%)</span>
                        </span>
                      </div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-yellow-500 rounded-full transition-all duration-500"
                          style={{ width: `${mainPct}%` }}
                        />
                      </div>
                    </div>

                    {/* Insurance */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-gray-400">Insurance</span>
                        <span className="text-xs text-gray-300 font-medium">
                          {formatCurrency(pred.estimated_insurance_cost)}{' '}
                          <span className="text-gray-600">({insPct}%)</span>
                        </span>
                      </div>
                      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-purple-500 rounded-full transition-all duration-500"
                          style={{ width: `${insPct}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Factors */}
                  {pred.factors && (
                    <div className="pt-3 border-t border-gray-800 space-y-1">
                      {pred.factors.driving_impact && (
                        <p className="text-xs text-gray-500">
                          <span className="text-gray-400 font-medium">Driving:</span>{' '}
                          {pred.factors.driving_impact}
                        </p>
                      )}
                      {pred.factors.historical_trend && (
                        <p className="text-xs text-gray-500">
                          <span className="text-gray-400 font-medium">Trend:</span>{' '}
                          {pred.factors.historical_trend}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fleet Cost Summary */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="inline-flex p-2 rounded-lg bg-blue-500/20">
            <BarChart2 className="w-5 h-5 text-blue-500" />
          </div>
          <h2 className="text-xl font-bold text-white">Fleet Cost Summary</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Total monthly */}
          <div className="bg-gray-800/50 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Total Fleet Monthly Cost</p>
            <p className="text-2xl font-bold text-white">{formatCurrency(totalMonthlyForecast)}</p>
            <p className="text-xs text-gray-500 mt-1">
              across {latestPredictions.length} vehicle{latestPredictions.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Projected annual */}
          <div className="bg-gray-800/50 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Projected Annual Cost</p>
            <p className="text-2xl font-bold text-white">
              {formatCurrency(totalMonthlyForecast * 12)}
            </p>
            <p className="text-xs text-gray-500 mt-1">based on current monthly forecast × 12</p>
          </div>

          {/* Savings opportunities */}
          <div className="bg-gray-800/50 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Savings Opportunities</p>
            <div className="flex items-end gap-2">
              <p className="text-2xl font-bold text-white">{costInsights.length}</p>
              {costInsights.length > 0 && (
                <span className="mb-0.5 text-xs font-medium px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                  Action Needed
                </span>
              )}
            </div>
            {costInsights.length > 0 ? (
              <div className="mt-2 space-y-1">
                {(() => {
                  const criticalSavings = costInsights
                    .filter(i => i.severity === 'critical')
                    .reduce((s, i) => s + (i.potential_savings || 0), 0);
                  const warningSavings = costInsights
                    .filter(i => i.severity === 'warning')
                    .reduce((s, i) => s + (i.potential_savings || 0), 0);
                  const infoSavings = costInsights
                    .filter(i => i.severity === 'info')
                    .reduce((s, i) => s + (i.potential_savings || 0), 0);
                  return (
                    <>
                      {criticalSavings > 0 && (
                        <p className="text-xs text-red-400">
                          Critical: {formatCurrency(criticalSavings)} potential savings
                        </p>
                      )}
                      {warningSavings > 0 && (
                        <p className="text-xs text-yellow-400">
                          Warning: {formatCurrency(warningSavings)} potential savings
                        </p>
                      )}
                      {infoSavings > 0 && (
                        <p className="text-xs text-blue-400">
                          Info: {formatCurrency(infoSavings)} potential savings
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <p className="text-xs text-green-400 mt-1">No open opportunities detected</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

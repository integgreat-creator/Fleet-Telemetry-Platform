import { useState, useEffect } from 'react';
import { Car, Activity, AlertTriangle, TrendingUp, Wifi, WifiOff, Shield } from 'lucide-react';
import { supabase, type Vehicle, type Alert } from '../lib/supabase';

export default function FleetOverview() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [vehicleEvents, setVehicleEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    // Kick off the analytics pipeline immediately, then every 5 minutes.
    // Runs silently in the background — errors are swallowed so UI is unaffected.
    const runIntelligence = async () => {
      const base = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/fleet-intelligence`;
      const headers = {
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      };
      const actions = [
        'detect-trips',
        'populate-behavior',
        'calculate-scores',
        'predict-fuel',
        'predict-costs',
        'generate-insights',
        'detect-anomalies',
        'detect-gaps',
        'score-trip-data',
      ];
      for (const action of actions) {
        try {
          await fetch(`${base}?action=${action}`, { method: 'POST', headers });
        } catch { /* silent */ }
      }
    };
    runIntelligence();
    const timer = setInterval(runIntelligence, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const loadData = async () => {
    try {
      const [vehiclesRes, alertsRes, eventsRes] = await Promise.all([
        supabase.from('vehicles').select('*'),
        supabase
          .from('alerts')
          .select('*')
          .eq('acknowledged', false)
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('vehicle_events')
          .select('*')
          .eq('acknowledged', false)
          .order('created_at', { ascending: false })
          .limit(5),
      ]);

      if (vehiclesRes.data) setVehicles(vehiclesRes.data);
      if (alertsRes.data) setAlerts(alertsRes.data);
      if (eventsRes.data) setVehicleEvents(eventsRes.data);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const activeVehicles = vehicles.filter(v => v.is_active).length;
  const totalVehicles = vehicles.length;
  const criticalAlerts = alerts.filter(a => a.severity === 'critical').length;
  const avgHealthScore = vehicles.length > 0
    ? vehicles.reduce((sum, v) => sum + v.health_score, 0) / vehicles.length
    : 0;

  // Derived counters from vehicle_events
  const offlineVehicleIds = new Set(
    vehicleEvents.filter(e => e.event_type === 'device_offline').map(e => e.vehicle_id)
  );
  const tamperVehicleIds = new Set(
    vehicleEvents.filter(e => e.event_type === 'device_tamper').map(e => e.vehicle_id)
  );
  const offlineVehicles = offlineVehicleIds.size;
  const tamperAlerts = tamperVehicleIds.size;

  // Per-vehicle status helper
  const getVehicleStatus = (vehicleId: string) => {
    if (tamperVehicleIds.has(vehicleId)) return 'tampered';
    if (offlineVehicleIds.has(vehicleId)) return 'offline';
    return 'online';
  };

  const stats = [
    {
      label: 'Total Vehicles',
      value: totalVehicles,
      icon: Car,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/20',
    },
    {
      label: 'Active Vehicles',
      value: activeVehicles,
      icon: Activity,
      color: 'text-green-500',
      bgColor: 'bg-green-500/20',
    },
    {
      label: 'Active Alerts',
      value: alerts.length,
      icon: AlertTriangle,
      color: 'text-yellow-500',
      bgColor: 'bg-yellow-500/20',
    },
    {
      label: 'Avg Health Score',
      value: `${avgHealthScore.toFixed(0)}%`,
      icon: TrendingUp,
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/20',
    },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Fleet Overview</h1>
        <p className="text-gray-400">Real-time monitoring and analytics for your entire fleet</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-gray-900 rounded-lg p-6 border border-gray-800">
              <div className="flex items-center justify-between mb-4">
                <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                  <Icon className={`w-6 h-6 ${stat.color}`} />
                </div>
              </div>
              <h3 className="text-3xl font-bold text-white mb-1">{stat.value}</h3>
              <p className="text-sm text-gray-400">{stat.label}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">Recent Alerts</h2>
          {alerts.length === 0 ? (
            <p className="text-gray-400 text-center py-8">No active alerts</p>
          ) : (
            <div className="space-y-3">
              {alerts.slice(0, 5).map((alert) => (
                <div
                  key={alert.id}
                  className={`p-3 rounded-lg border ${
                    alert.severity === 'critical'
                      ? 'border-red-500/50 bg-red-500/10'
                      : alert.severity === 'warning'
                      ? 'border-yellow-500/50 bg-yellow-500/10'
                      : 'border-blue-500/50 bg-blue-500/10'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-white font-medium text-sm">{alert.sensor_type}</p>
                      <p className="text-gray-400 text-xs">{alert.message}</p>
                    </div>
                    <span
                      className={`text-xs font-medium px-2 py-1 rounded ${
                        alert.severity === 'critical'
                          ? 'bg-red-500/20 text-red-400'
                          : alert.severity === 'warning'
                          ? 'bg-yellow-500/20 text-yellow-400'
                          : 'bg-blue-500/20 text-blue-400'
                      }`}
                    >
                      {alert.severity}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
          <h2 className="text-xl font-bold text-white mb-4">Fleet Status</h2>
          {(offlineVehicles > 0 || tamperAlerts > 0) && (
            <div className="flex gap-3 mb-4 flex-wrap">
              {offlineVehicles > 0 && (
                <div className="flex items-center gap-1.5 text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded-full">
                  <WifiOff className="w-3 h-3 text-red-400" />
                  {offlineVehicles} offline
                </div>
              )}
              {tamperAlerts > 0 && (
                <div className="flex items-center gap-1.5 text-xs bg-gray-700 text-gray-300 px-2 py-1 rounded-full">
                  <Shield className="w-3 h-3 text-yellow-400" />
                  {tamperAlerts} tamper alert{tamperAlerts !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          )}
          <div className="space-y-4">
            {vehicles.slice(0, 5).map((vehicle) => {
              const status = getVehicleStatus(vehicle.id);
              return (
                <div key={vehicle.id} className="flex items-center justify-between p-3 bg-gray-800 rounded-lg">
                  <div className="flex items-center space-x-3">
                    {status === 'online' && vehicle.is_active
                      ? <Wifi className="w-4 h-4 text-green-500 flex-shrink-0" />
                      : status === 'offline'
                      ? <WifiOff className="w-4 h-4 text-red-500 flex-shrink-0" />
                      : status === 'tampered'
                      ? <Shield className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                      : <div className="w-3 h-3 rounded-full bg-gray-600 flex-shrink-0" />
                    }
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-white font-medium text-sm">{vehicle.name}</p>
                        {status === 'tampered' && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">Tampered</span>
                        )}
                        {status === 'offline' && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">Offline</span>
                        )}
                      </div>
                      <p className="text-gray-400 text-xs">{vehicle.make} {vehicle.model}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-bold ${
                      vehicle.health_score >= 80
                        ? 'text-green-500'
                        : vehicle.health_score >= 60
                        ? 'text-yellow-500'
                        : 'text-red-500'
                    }`}>
                      {vehicle.health_score.toFixed(0)}%
                    </p>
                    <p className="text-xs text-gray-500">Health</p>
                  </div>
                </div>
              );
            })}
            {vehicles.length === 0 && (
              <p className="text-gray-400 text-center py-8">No vehicles yet</p>
            )}
          </div>
        </div>
      </div>

      {criticalAlerts > 0 && (
        <div className="bg-red-500/10 border-2 border-red-500 rounded-lg p-6">
          <div className="flex items-start space-x-3">
            <AlertTriangle className="w-6 h-6 text-red-500 flex-shrink-0 mt-1" />
            <div>
              <h3 className="text-lg font-bold text-white mb-1">Critical Alerts Detected</h3>
              <p className="text-gray-300">
                You have {criticalAlerts} critical alert{criticalAlerts !== 1 ? 's' : ''} requiring immediate attention.
                Please review the Alerts page for details.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

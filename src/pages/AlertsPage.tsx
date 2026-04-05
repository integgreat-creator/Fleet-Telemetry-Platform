import { useState, useEffect } from 'react';
import { Filter } from 'lucide-react';
import { supabase, type Alert } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import AlertCard from '../components/AlertCard';

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all');
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  useEffect(() => {
    loadAlerts();
  }, []);

  const loadAlerts = async () => {
    try {
      // Load alerts (RLS ensures only caller's fleet vehicles are returned)
      const { data, error } = await supabase
        .from('alerts')
        .select('*, vehicles(name, vin)')
        .order('created_at', { ascending: false });

      if (error) throw error;
      if (data) {
        setAlerts(data);

        // BUG FIX: subscribe with vehicle filter so only the user's fleet
        // alerts arrive via realtime — not every alert in the database
        const vehicleIds = [...new Set(data.map((a: Alert) => a.vehicle_id))];
        const unsubscribe = realtimeService.subscribeToAlerts(vehicleIds, (newAlert) => {
          setAlerts((prev) => [newAlert as Alert, ...prev]);
        });
        // Store cleanup so it runs on unmount
        return unsubscribe;
      }
    } catch (error) {
      console.error('Error loading alerts:', error);
    } finally {
      setLoading(false);
    }
    return () => {};
  };

  const handleAcknowledge = async (alertId: string) => {
    try {
      const { error } = await supabase
        .from('alerts')
        .update({
          acknowledged: true,
          acknowledged_at: new Date().toISOString(),
        })
        .eq('id', alertId);

      if (error) throw error;

      setAlerts((prev) =>
        prev.map((alert) =>
          alert.id === alertId
            ? { ...alert, acknowledged: true, acknowledged_at: new Date().toISOString() }
            : alert
        )
      );
    } catch (error) {
      console.error('Error acknowledging alert:', error);
    }
  };

  const filteredAlerts = alerts.filter((alert) => {
    if (!showAcknowledged && alert.acknowledged) return false;
    if (filter === 'all') return true;
    return alert.severity === filter;
  });

  const criticalCount = alerts.filter((a) => a.severity === 'critical' && !a.acknowledged).length;
  const warningCount = alerts.filter((a) => a.severity === 'warning' && !a.acknowledged).length;
  const infoCount = alerts.filter((a) => a.severity === 'info' && !a.acknowledged).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Alerts</h1>
        <p className="text-gray-400">Monitor and manage system alerts and notifications</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-sm text-gray-400 mb-1">Critical Alerts</p>
          <p className="text-3xl font-bold text-red-500">{criticalCount}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-sm text-gray-400 mb-1">Warnings</p>
          <p className="text-3xl font-bold text-yellow-500">{warningCount}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-sm text-gray-400 mb-1">Info</p>
          <p className="text-3xl font-bold text-blue-500">{infoCount}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-sm text-gray-400 mb-1">Total Alerts</p>
          <p className="text-3xl font-bold text-white">{alerts.length}</p>
        </div>
      </div>

      <div className="flex items-center justify-between bg-gray-900 rounded-lg p-4 border border-gray-800">
        <div className="flex items-center space-x-4">
          <Filter className="w-5 h-5 text-gray-400" />
          <div className="flex space-x-2">
            {(['all', 'critical', 'warning', 'info'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  filter === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showAcknowledged}
            onChange={(e) => setShowAcknowledged(e.target.checked)}
            className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-400">Show Acknowledged</span>
        </label>
      </div>

      {filteredAlerts.length === 0 ? (
        <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
          <p className="text-gray-400">No alerts to display</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredAlerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} onAcknowledge={handleAcknowledge} />
          ))}
        </div>
      )}
    </div>
  );
}

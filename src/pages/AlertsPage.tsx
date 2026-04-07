import { useState, useEffect, useCallback } from 'react';
import { Filter, AlertTriangle, Wifi, WifiOff, Navigation, Clock, Shield } from 'lucide-react';
import { supabase, type Alert } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import AlertCard from '../components/AlertCard';

interface VehicleEvent {
  id: string;
  vehicle_id: string;
  fleet_id: string;
  event_type: string;
  severity: 'warning' | 'critical';
  title: string;
  description: string;
  metadata: Record<string, any>;
  whatsapp_sent: boolean;
  acknowledged: boolean;
  acknowledged_at: string | null;
  created_at: string;
  vehicles?: { name: string; vin: string } | null;
}

const EVENT_ICONS: Record<string, React.ReactNode> = {
  device_offline:        <WifiOff className="w-4 h-4" />,
  device_tamper:         <Shield className="w-4 h-4" />,
  unauthorized_movement: <Navigation className="w-4 h-4" />,
  excessive_idle:        <Clock className="w-4 h-4" />,
  trip_gap:              <Clock className="w-4 h-4" />,
  mock_gps_detected:     <Shield className="w-4 h-4" />,
  ignition_no_data:      <WifiOff className="w-4 h-4" />,
  device_online:         <Wifi className="w-4 h-4" />,
};

const EVENT_LABELS: Record<string, string> = {
  device_offline:        'Device Offline',
  device_tamper:         'Possible Tamper',
  unauthorized_movement: 'Unauthorized Movement',
  excessive_idle:        'Excessive Idle',
  trip_gap:              'Trip Gap',
  mock_gps_detected:     'Mock GPS',
  ignition_no_data:      'Ignition No Data',
  device_online:         'Device Online',
};

export default function AlertsPage() {
  const [activeTab, setActiveTab]     = useState<'sensor' | 'events'>('sensor');
  const [alerts, setAlerts]           = useState<Alert[]>([]);
  const [events, setEvents]           = useState<VehicleEvent[]>([]);
  const [loading, setLoading]         = useState(true);
  const [filter, setFilter]           = useState<'all' | 'critical' | 'warning' | 'info'>('all');
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [alertsRes, eventsRes] = await Promise.all([
        supabase.from('alerts').select('*, vehicles(name, vin)').order('created_at', { ascending: false }),
        supabase.from('vehicle_events').select('*, vehicles(name, vin)').order('created_at', { ascending: false }).limit(200),
      ]);

      if (alertsRes.data) {
        setAlerts(alertsRes.data);
        const vehicleIds = [...new Set(alertsRes.data.map((a: Alert) => a.vehicle_id))];
        realtimeService.subscribeToAlerts(vehicleIds, (newAlert) => {
          setAlerts(prev => [newAlert as Alert, ...prev]);
        });
      }

      if (eventsRes.data) {
        setEvents(eventsRes.data as VehicleEvent[]);

        // Realtime subscription for vehicle_events
        const evVehicleIds = [...new Set((eventsRes.data as VehicleEvent[]).map(e => e.vehicle_id))];
        if (evVehicleIds.length > 0) {
          supabase
            .channel(`vehicle_events:fleet`)
            .onPostgresChanges({
              event: 'INSERT',
              schema: 'public',
              table: 'vehicle_events',
              filter: `vehicle_id=in.(${evVehicleIds.join(',')})`,
            }, payload => {
              setEvents(prev => [payload.new as VehicleEvent, ...prev]);
            })
            .subscribe();
        }
      }
    } catch (e) {
      console.error('Error loading alerts/events:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleAcknowledge = async (alertId: string) => {
    await supabase.from('alerts').update({
      acknowledged: true, acknowledged_at: new Date().toISOString(),
    }).eq('id', alertId);
    setAlerts(prev => prev.map(a => a.id === alertId
      ? { ...a, acknowledged: true, acknowledged_at: new Date().toISOString() } : a));
  };

  const handleAcknowledgeEvent = async (eventId: string) => {
    await supabase.from('vehicle_events').update({
      acknowledged: true, acknowledged_at: new Date().toISOString(),
    }).eq('id', eventId);
    setEvents(prev => prev.map(e => e.id === eventId
      ? { ...e, acknowledged: true, acknowledged_at: new Date().toISOString() } : e));
  };

  const filteredAlerts = alerts.filter(a => {
    if (!showAcknowledged && a.acknowledged) return false;
    if (filter === 'all') return true;
    return a.severity === filter;
  });

  const filteredEvents = events.filter(e => {
    if (!showAcknowledged && e.acknowledged) return false;
    if (filter === 'all') return true;
    return e.severity === filter;
  });

  const criticalAlerts = alerts.filter(a => a.severity === 'critical' && !a.acknowledged).length;
  const warningAlerts  = alerts.filter(a => a.severity === 'warning'  && !a.acknowledged).length;
  const criticalEvents = events.filter(e => e.severity === 'critical' && !e.acknowledged).length;
  const warningEvents  = events.filter(e => e.severity === 'warning'  && !e.acknowledged).length;

  const totalCritical = criticalAlerts + criticalEvents;
  const totalWarning  = warningAlerts  + warningEvents;

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Alerts & Events</h1>
        <p className="text-gray-400">Sensor threshold alerts and system reliability events</p>
      </div>

      {/* Summary counters */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">Critical</p>
          <p className="text-3xl font-bold text-red-500">{totalCritical}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">Warnings</p>
          <p className="text-3xl font-bold text-yellow-500">{totalWarning}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">Sensor Alerts</p>
          <p className="text-3xl font-bold text-blue-400">{alerts.filter(a => !a.acknowledged).length}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-xs text-gray-400 mb-1">System Events</p>
          <p className="text-3xl font-bold text-purple-400">{events.filter(e => !e.acknowledged).length}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-900 p-1 rounded-lg border border-gray-800 w-fit">
        <button
          onClick={() => setActiveTab('sensor')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
            activeTab === 'sensor' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <AlertTriangle className="w-4 h-4" />
          Sensor Alerts
          {criticalAlerts + warningAlerts > 0 && (
            <span className="bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {criticalAlerts + warningAlerts}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('events')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
            activeTab === 'events' ? 'bg-purple-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <Shield className="w-4 h-4" />
          System Events
          {criticalEvents + warningEvents > 0 && (
            <span className="bg-orange-500 text-white text-xs rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
              {criticalEvents + warningEvents}
            </span>
          )}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center justify-between bg-gray-900 rounded-lg p-4 border border-gray-800">
        <div className="flex items-center gap-3">
          <Filter className="w-4 h-4 text-gray-400" />
          <div className="flex gap-2">
            {(['all', 'critical', 'warning'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${
                  filter === f ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}>
                {f}
              </button>
            ))}
            {activeTab === 'sensor' && (
              <button onClick={() => setFilter('info')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  filter === 'info' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}>
                Info
              </button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showAcknowledged}
            onChange={e => setShowAcknowledged(e.target.checked)}
            className="w-4 h-4 rounded border-gray-700 bg-gray-800 text-blue-600" />
          <span className="text-xs text-gray-400">Show Acknowledged</span>
        </label>
      </div>

      {/* Sensor alerts tab */}
      {activeTab === 'sensor' && (
        filteredAlerts.length === 0 ? (
          <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
            <AlertTriangle className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-400">No sensor alerts to display</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAlerts.map(alert => (
              <AlertCard key={alert.id} alert={alert} onAcknowledge={handleAcknowledge} />
            ))}
          </div>
        )
      )}

      {/* System events tab */}
      {activeTab === 'events' && (
        filteredEvents.length === 0 ? (
          <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
            <Shield className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-400">No system events to display</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredEvents.map(ev => (
              <div key={ev.id}
                className={`rounded-xl border p-4 transition-opacity ${
                  ev.acknowledged ? 'opacity-50' : ''
                } ${
                  ev.severity === 'critical'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-yellow-500/40 bg-yellow-500/5'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`mt-0.5 flex-shrink-0 ${
                      ev.severity === 'critical' ? 'text-red-400' : 'text-yellow-400'
                    }`}>
                      {EVENT_ICONS[ev.event_type] ?? <AlertTriangle className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-white font-semibold text-sm">{ev.title}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          ev.severity === 'critical'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                        </span>
                        {ev.whatsapp_sent && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                            WhatsApp ✓
                          </span>
                        )}
                      </div>
                      <p className="text-gray-400 text-xs mt-1">{ev.description}</p>
                      <p className="text-gray-600 text-xs mt-1">
                        {ev.vehicles?.name && <span className="text-gray-500">{ev.vehicles.name} · </span>}
                        {new Date(ev.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                  {!ev.acknowledged && (
                    <button
                      onClick={() => handleAcknowledgeEvent(ev.id)}
                      className="flex-shrink-0 text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors"
                    >
                      Acknowledge
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

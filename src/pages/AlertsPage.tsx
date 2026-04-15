import { useState, useEffect, useCallback } from 'react';
import {
  Filter, AlertTriangle, Wifi, WifiOff, Navigation, Clock,
  Shield, SlidersHorizontal, Bell, BellOff, RotateCcw, Save,
  Loader, ChevronDown, CheckCircle2, MapPin,
} from 'lucide-react';
import { supabase, type Alert, type Vehicle, type Threshold } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import { vehicleSimulator } from '../services/simulatorService';
import AlertCard from '../components/AlertCard';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  device_offline:              <WifiOff className="w-4 h-4" />,
  device_tamper:               <Shield className="w-4 h-4" />,
  unauthorized_movement:       <Navigation className="w-4 h-4" />,
  excessive_idle:              <Clock className="w-4 h-4" />,
  trip_gap:                    <Clock className="w-4 h-4" />,
  mock_gps_detected:           <Shield className="w-4 h-4" />,
  ignition_no_data:            <WifiOff className="w-4 h-4" />,
  device_online:               <Wifi className="w-4 h-4" />,
  // Geofence events
  geofence_entry:              <MapPin className="w-4 h-4" />,
  geofence_entry_restricted:   <MapPin className="w-4 h-4" />,
  geofence_exit:               <MapPin className="w-4 h-4" />,
  geofence_dwell:              <Clock className="w-4 h-4" />,
  night_movement:              <Shield className="w-4 h-4" />,
};

const EVENT_LABELS: Record<string, string> = {
  device_offline:              'Device Offline',
  device_tamper:               'Possible Tamper',
  unauthorized_movement:       'Unauthorized Movement',
  excessive_idle:              'Excessive Idle',
  trip_gap:                    'Trip Gap',
  mock_gps_detected:           'Mock GPS',
  ignition_no_data:            'Ignition No Data',
  device_online:               'Device Online',
  // Geofence events
  geofence_entry:              'Zone Entry',
  geofence_entry_restricted:   'Restricted Zone Entry',
  geofence_exit:               'Zone Exit',
  geofence_dwell:              'Zone Dwell',
  night_movement:              'Night Movement',
};

// ─── All known sensor types with optimal defaults ─────────────────────────────
// These values represent safe operating ranges for standard OBD-II sensors.
// Fleet managers can override per vehicle; these act as the starting baseline.

interface SensorDefault {
  sensor_type: string;
  label:       string;
  unit:        string;
  normal_min:  number;
  normal_max:  number;
  category:    string;
}

const SENSOR_DEFAULTS: SensorDefault[] = [
  // Engine
  { sensor_type: 'rpm',                   label: 'Engine RPM',              unit: 'RPM',     normal_min: 600,   normal_max: 3000,  category: 'Engine'   },
  { sensor_type: 'engine_load',           label: 'Engine Load',             unit: '%',       normal_min: 0,     normal_max: 85,    category: 'Engine'   },
  { sensor_type: 'coolant_temp',          label: 'Coolant Temperature',     unit: '°C',      normal_min: 80,    normal_max: 100,   category: 'Engine'   },
  { sensor_type: 'engine_oil_temp',       label: 'Engine Oil Temperature',  unit: '°C',      normal_min: 80,    normal_max: 110,   category: 'Engine'   },
  { sensor_type: 'engine_fuel_rate',      label: 'Fuel Rate',               unit: 'L/h',     normal_min: 0,     normal_max: 20,    category: 'Engine'   },
  { sensor_type: 'engine_runtime',        label: 'Engine Runtime',          unit: 's',       normal_min: 0,     normal_max: 65535, category: 'Engine'   },
  { sensor_type: 'timing_advance',        label: 'Timing Advance',          unit: '° BTDC',  normal_min: -20,   normal_max: 45,    category: 'Engine'   },
  // Air & Fuel
  { sensor_type: 'intake_temp',           label: 'Intake Air Temperature',  unit: '°C',      normal_min: 10,    normal_max: 50,    category: 'Air & Fuel' },
  { sensor_type: 'manifold_pressure',     label: 'Manifold Pressure',       unit: 'kPa',     normal_min: 20,    normal_max: 105,   category: 'Air & Fuel' },
  { sensor_type: 'maf',                   label: 'Mass Air Flow',           unit: 'g/s',     normal_min: 2,     normal_max: 500,   category: 'Air & Fuel' },
  { sensor_type: 'throttle_position',     label: 'Throttle Position',       unit: '%',       normal_min: 0,     normal_max: 100,   category: 'Air & Fuel' },
  { sensor_type: 'fuel_pressure',         label: 'Fuel Pressure',           unit: 'kPa',     normal_min: 200,   normal_max: 600,   category: 'Air & Fuel' },
  { sensor_type: 'short_fuel_trim',       label: 'Short Fuel Trim',         unit: '%',       normal_min: -15,   normal_max: 15,    category: 'Air & Fuel' },
  { sensor_type: 'long_fuel_trim',        label: 'Long Fuel Trim',          unit: '%',       normal_min: -10,   normal_max: 10,    category: 'Air & Fuel' },
  // Movement
  { sensor_type: 'speed',                 label: 'Vehicle Speed',           unit: 'km/h',    normal_min: 0,     normal_max: 120,   category: 'Movement' },
  { sensor_type: 'distance_since_mil',    label: 'Distance Since MIL',      unit: 'km',      normal_min: 0,     normal_max: 1,     category: 'Movement' },
  // Electrical
  { sensor_type: 'battery_voltage',       label: 'Battery Voltage',         unit: 'V',       normal_min: 11.5,  normal_max: 14.5,  category: 'Electrical' },
  { sensor_type: 'control_module_voltage',label: 'Control Module Voltage',  unit: 'V',       normal_min: 11,    normal_max: 15,    category: 'Electrical' },
  // Fuel levels
  { sensor_type: 'fuel_level',            label: 'Fuel Level',              unit: '%',       normal_min: 10,    normal_max: 100,   category: 'Fuel Level' },
  { sensor_type: 'cng_fuel_level',        label: 'CNG Fuel Level',          unit: '%',       normal_min: 10,    normal_max: 100,   category: 'Fuel Level' },
  { sensor_type: 'cng_cylinder_pressure', label: 'CNG Cylinder Pressure',   unit: 'bar',     normal_min: 20,    normal_max: 250,   category: 'Fuel Level' },
  // EV
  { sensor_type: 'ev_battery_level',      label: 'EV Battery Level',        unit: '%',       normal_min: 20,    normal_max: 100,   category: 'Electric' },
  { sensor_type: 'ev_range_estimate',     label: 'EV Range Estimate',       unit: 'km',      normal_min: 50,    normal_max: 800,   category: 'Electric' },
  // Environment
  { sensor_type: 'ambient_temp',          label: 'Ambient Temperature',     unit: '°C',      normal_min: -10,   normal_max: 45,    category: 'Environment' },
];

const CATEGORIES = [...new Set(SENSOR_DEFAULTS.map(s => s.category))];

// ─── Threshold row state ──────────────────────────────────────────────────────

interface ThresholdRow {
  sensor_type:   string;
  min_value:     string;
  max_value:     string;
  alert_enabled: boolean;
  existing_id?:  string;
  modified:      boolean;
}

function buildDefaultRows(existing: Threshold[]): ThresholdRow[] {
  const map = new Map(existing.map(t => [t.sensor_type, t]));
  return SENSOR_DEFAULTS.map(sd => {
    const t = map.get(sd.sensor_type);
    return {
      sensor_type:   sd.sensor_type,
      min_value:     t?.min_value != null ? String(t.min_value) : String(sd.normal_min),
      max_value:     t?.max_value != null ? String(t.max_value) : String(sd.normal_max),
      alert_enabled: t?.alert_enabled ?? true,
      existing_id:   t?.id,
      modified:      false,
    };
  });
}

// ─── Thresholds tab component ─────────────────────────────────────────────────

function ThresholdsTab({ vehicles }: { vehicles: Vehicle[] }) {
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>(vehicles[0]?.id ?? '');
  const [rows, setRows]         = useState<ThresholdRow[]>([]);
  const [loading, setLoading]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('All');

  const loadThresholds = useCallback(async (vehicleId: string) => {
    if (!vehicleId) return;
    setLoading(true);
    setSavedMsg('');
    try {
      const { data } = await supabase
        .from('thresholds')
        .select('*')
        .eq('vehicle_id', vehicleId);
      setRows(buildDefaultRows((data ?? []) as Threshold[]));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedVehicleId) loadThresholds(selectedVehicleId);
  }, [selectedVehicleId, loadThresholds]);

  const updateRow = (idx: number, patch: Partial<ThresholdRow>) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch, modified: true } : r));
    setSavedMsg('');
  };

  const resetToDefaults = () => {
    setRows(prev => prev.map(row => {
      const sd = SENSOR_DEFAULTS.find(s => s.sensor_type === row.sensor_type)!;
      return { ...row, min_value: String(sd.normal_min), max_value: String(sd.normal_max), alert_enabled: true, modified: true };
    }));
    setSavedMsg('');
  };

  const handleSave = async () => {
    if (!selectedVehicleId) return;
    setSaving(true);
    try {
      const upserts = rows.map(r => ({
        ...(r.existing_id ? { id: r.existing_id } : {}),
        vehicle_id:    selectedVehicleId,
        sensor_type:   r.sensor_type,
        min_value:     r.min_value !== '' ? parseFloat(r.min_value) : null,
        max_value:     r.max_value !== '' ? parseFloat(r.max_value) : null,
        alert_enabled: r.alert_enabled,
      }));

      const { error } = await supabase
        .from('thresholds')
        .upsert(upserts, { onConflict: 'vehicle_id,sensor_type' });

      if (!error) {
        setRows(prev => prev.map(r => ({ ...r, modified: false })));
        setSavedMsg(`All thresholds saved for ${vehicles.find(v => v.id === selectedVehicleId)?.name ?? 'vehicle'}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const visibleRows = activeCategory === 'All'
    ? rows
    : rows.filter(r => SENSOR_DEFAULTS.find(s => s.sensor_type === r.sensor_type)?.category === activeCategory);

  const modifiedCount = rows.filter(r => r.modified).length;
  const selectedVehicle = vehicles.find(v => v.id === selectedVehicleId);

  if (vehicles.length === 0) {
    return (
      <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
        <SlidersHorizontal className="w-12 h-12 text-gray-700 mx-auto mb-3" />
        <p className="text-gray-400">No vehicles registered yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3">

        {/* Vehicle picker */}
        <div className="relative">
          <select
            value={selectedVehicleId}
            onChange={e => setSelectedVehicleId(e.target.value)}
            className="appearance-none bg-gray-900 border border-gray-700 text-white text-sm rounded-lg pl-4 pr-8 py-2.5 focus:outline-none focus:border-blue-500 cursor-pointer"
          >
            {vehicles.map(v => (
              <option key={v.id} value={v.id}>{v.name} — {v.make} {v.model}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>

        {/* Category filter pills */}
        <div className="flex gap-1 flex-wrap">
          {['All', ...CATEGORIES].map(cat => (
            <button key={cat} onClick={() => setActiveCategory(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-400 hover:text-white'
              }`}>
              {cat}
            </button>
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Reset to defaults */}
        <button onClick={resetToDefaults}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors"
          title="Reset all sensors to optimal default thresholds">
          <RotateCcw className="w-4 h-4" />
          Reset to Defaults
        </button>

        {/* Save */}
        <button onClick={handleSave} disabled={saving || loading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors">
          {saving
            ? <Loader className="w-4 h-4 animate-spin" />
            : <Save className="w-4 h-4" />
          }
          Save{modifiedCount > 0 ? ` (${modifiedCount})` : ''}
        </button>
      </div>

      {/* Saved confirmation */}
      {savedMsg && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {savedMsg}
        </div>
      )}

      {/* Optimal defaults info banner */}
      <div className="flex items-start gap-2.5 px-4 py-3 bg-blue-500/5 border border-blue-500/20 rounded-lg text-xs text-blue-300">
        <SlidersHorizontal className="w-4 h-4 flex-shrink-0 mt-0.5 text-blue-400" />
        <span>
          <strong>Optimal defaults</strong> are pre-filled based on safe OBD-II operating ranges for{' '}
          <strong>{selectedVehicle?.make} {selectedVehicle?.model}</strong>.
          Adjust per vehicle as needed and click <strong>Save</strong>.
          Alerts fire when a reading falls outside the Min–Max range.
        </span>
      </div>

      {/* Column headers */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="grid grid-cols-[2fr_80px_110px_110px_50px] gap-0 px-4 py-2.5 bg-gray-800/60 border-b border-gray-800">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Sensor</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Unit</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider text-right pr-2">Min</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider text-right pr-2">Max</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider text-center">Alert</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader className="w-6 h-6 animate-spin text-blue-500" />
          </div>
        ) : (
          <div>
            {/* Group by category */}
            {(activeCategory === 'All' ? CATEGORIES : [activeCategory]).map(cat => {
              const catRows = visibleRows.filter(
                r => SENSOR_DEFAULTS.find(s => s.sensor_type === r.sensor_type)?.category === cat
              );
              if (catRows.length === 0) return null;
              return (
                <div key={cat}>
                  {/* Category header */}
                  <div className="px-4 py-1.5 bg-gray-800/30 border-b border-gray-800/60">
                    <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">{cat}</p>
                  </div>
                  {catRows.map((row, _i) => {
                    const idx  = rows.findIndex(r => r.sensor_type === row.sensor_type);
                    const sd   = SENSOR_DEFAULTS.find(s => s.sensor_type === row.sensor_type)!;
                    const isDefault =
                      row.min_value === String(sd.normal_min) &&
                      row.max_value === String(sd.normal_max) &&
                      row.alert_enabled;
                    return (
                      <div
                        key={row.sensor_type}
                        className={`grid grid-cols-[2fr_80px_110px_110px_50px] gap-0 px-4 py-2.5 border-b border-gray-800/40 last:border-0 items-center transition-colors ${
                          row.modified ? 'bg-blue-500/5' : 'hover:bg-gray-800/30'
                        }`}
                      >
                        {/* Sensor name */}
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm text-white font-medium truncate">{sd.label}</p>
                          {isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-500 flex-shrink-0">optimal</span>
                          )}
                          {row.modified && !isDefault && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 flex-shrink-0">modified</span>
                          )}
                        </div>

                        {/* Unit */}
                        <p className="text-xs text-gray-500">{sd.unit}</p>

                        {/* Min */}
                        <div className="pr-2">
                          <input
                            type="number"
                            value={row.min_value}
                            onChange={e => updateRow(idx, { min_value: e.target.value })}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 text-right"
                          />
                        </div>

                        {/* Max */}
                        <div className="pr-2">
                          <input
                            type="number"
                            value={row.max_value}
                            onChange={e => updateRow(idx, { max_value: e.target.value })}
                            className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 text-right"
                          />
                        </div>

                        {/* Alert toggle */}
                        <div className="flex justify-center">
                          <button
                            onClick={() => updateRow(idx, { alert_enabled: !row.alert_enabled })}
                            title={row.alert_enabled ? 'Alerts on — click to mute' : 'Alerts muted — click to enable'}
                            className={`p-1.5 rounded-lg transition-colors ${
                              row.alert_enabled
                                ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                                : 'bg-gray-800 text-gray-600 hover:bg-gray-700 hover:text-gray-400'
                            }`}
                          >
                            {row.alert_enabled
                              ? <Bell className="w-4 h-4" />
                              : <BellOff className="w-4 h-4" />
                            }
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer note */}
      <p className="text-xs text-gray-600 text-center">
        Thresholds apply immediately to incoming sensor readings for <strong className="text-gray-500">{selectedVehicle?.name}</strong>.
        To configure another vehicle, use the vehicle selector above.
      </p>
    </div>
  );
}

// ─── Main AlertsPage ──────────────────────────────────────────────────────────

export default function AlertsPage() {
  const [activeTab, setActiveTab]     = useState<'sensor' | 'events' | 'thresholds'>('sensor');
  const [alerts, setAlerts]           = useState<Alert[]>([]);
  const [events, setEvents]           = useState<VehicleEvent[]>([]);
  const [vehicles, setVehicles]       = useState<Vehicle[]>([]);
  const [loading, setLoading]         = useState(true);
  const [filter, setFilter]           = useState<'all' | 'critical' | 'warning' | 'info'>('all');
  const [showAcknowledged, setShowAcknowledged] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [alertsRes, eventsRes, vehiclesRes] = await Promise.all([
        supabase.from('alerts').select('*, vehicles(name, vin)').order('created_at', { ascending: false }),
        supabase.from('vehicle_events').select('*, vehicles(name, vin)').order('created_at', { ascending: false }).limit(200),
        supabase.from('vehicles').select('*').order('name'),
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
        const evVehicleIds = [...new Set((eventsRes.data as VehicleEvent[]).map(e => e.vehicle_id))];
        if (evVehicleIds.length > 0) {
          supabase
            .channel(`vehicle_events:fleet`)
            .onPostgresChanges({
              event: 'INSERT', schema: 'public', table: 'vehicle_events',
              filter: `vehicle_id=in.(${evVehicleIds.join(',')})`,
            }, payload => {
              setEvents(prev => [payload.new as VehicleEvent, ...prev]);
            })
            .subscribe();
        }
      }
      if (vehiclesRes.data) setVehicles(vehiclesRes.data as Vehicle[]);
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
  const totalCritical  = criticalAlerts + criticalEvents;
  const totalWarning   = warningAlerts  + warningEvents;

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500" />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Alerts & Events</h1>
        <p className="text-gray-400">Sensor threshold alerts, system reliability events, and threshold configuration</p>
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

      {/* Tabs — Sensor Alerts | System Events | Thresholds */}
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
        <button
          onClick={() => setActiveTab('thresholds')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
            activeTab === 'thresholds' ? 'bg-teal-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4" />
          Thresholds
        </button>
      </div>

      {/* Filter bar — shown only on sensor/events tabs */}
      {activeTab !== 'thresholds' && (
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
      )}

      {/* ── Sensor Alerts tab ─────────────────────────────────────────────── */}
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

      {/* ── System Events tab ─────────────────────────────────────────────── */}
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
                className={`rounded-xl border p-4 transition-opacity ${ev.acknowledged ? 'opacity-50' : ''} ${
                  ev.severity === 'critical'
                    ? 'border-red-500/40 bg-red-500/5'
                    : 'border-yellow-500/40 bg-yellow-500/5'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`mt-0.5 flex-shrink-0 ${ev.severity === 'critical' ? 'text-red-400' : 'text-yellow-400'}`}>
                      {EVENT_ICONS[ev.event_type] ?? <AlertTriangle className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-white font-semibold text-sm">{ev.title}</p>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          ev.severity === 'critical' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {EVENT_LABELS[ev.event_type] ?? ev.event_type}
                        </span>
                        {ev.whatsapp_sent && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">WhatsApp ✓</span>
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
                    <button onClick={() => handleAcknowledgeEvent(ev.id)}
                      className="flex-shrink-0 text-xs px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg transition-colors">
                      Acknowledge
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Thresholds tab ────────────────────────────────────────────────── */}
      {activeTab === 'thresholds' && (
        <ThresholdsTab vehicles={vehicles} />
      )}
    </div>
  );
}

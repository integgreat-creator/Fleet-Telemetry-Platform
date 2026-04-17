import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Settings, X, Save, Bell, BellOff, Loader,
         Wrench, CheckCircle, AlertTriangle, Clock, History } from 'lucide-react';
import { supabase, type Vehicle, type SensorData, type Threshold } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import { vehicleSimulator } from '../services/simulatorService';
import SensorCard from '../components/SensorCard';
import { useSubscription } from '../hooks/useSubscription';

// ── Maintenance types (local to this file) ────────────────────────────────────

interface VehiclePrediction {
  id:              string;
  prediction_type: string;
  description:     string | null;
  due_at_km:       number | null;
  due_date:        string | null;
  urgency:         string;
  status:          'upcoming' | 'due' | 'overdue' | 'completed';
}

interface VehicleServiceLog {
  id:           string;
  service_type: string;
  service_date: string;
  odometer_km:  number | null;
  cost:         number | null;
  notes:        string | null;
}

const SERVICE_LABELS: Record<string, string> = {
  oil_change:       'Oil Change',
  tire_rotation:    'Tyre Rotation',
  air_filter:       'Air Filter',
  brake_inspection: 'Brake Inspection',
  engine_check:     'Engine Check',
};

const PRED_STATUS_STYLE: Record<string, { badge: string; text: string; label: string }> = {
  overdue:   { badge: 'bg-red-500/20 text-red-400 border border-red-500/30',      text: 'text-red-400',    label: 'Overdue'  },
  due:       { badge: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30', text: 'text-yellow-400', label: 'Due Soon' },
  upcoming:  { badge: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',    text: 'text-blue-400',   label: 'Upcoming' },
  completed: { badge: 'bg-green-500/20 text-green-400 border border-green-500/30', text: 'text-green-400',  label: 'Done'     },
};

interface VehicleDetailProps {
  vehicle: Vehicle;
  onBack: () => void;
}

// Human-readable sensor labels
const SENSOR_LABELS: Record<string, string> = {
  rpm:                   'Engine RPM',
  speed:                 'Vehicle Speed',
  coolant_temp:          'Coolant Temperature',
  fuel_level:            'Fuel Level',
  battery_voltage:       'Battery Voltage',
  throttle_position:     'Throttle Position',
  intake_temp:           'Intake Air Temp',
  engine_load:           'Engine Load',
  maf:                   'Mass Air Flow',
  timing_advance:        'Timing Advance',
  short_fuel_trim:       'Short Fuel Trim',
  long_fuel_trim:        'Long Fuel Trim',
  manifold_pressure:     'Manifold Pressure',
  fuel_pressure:         'Fuel Pressure',
  distance_since_mil:    'Distance Since MIL',
  engine_runtime:        'Engine Runtime',
  control_module_voltage:'Control Module Voltage',
  ambient_temp:          'Ambient Temperature',
  engine_oil_temp:       'Engine Oil Temp',
  engine_fuel_rate:      'Fuel Rate',
  cng_cylinder_pressure: 'CNG Cylinder Pressure',
  cng_fuel_level:        'CNG Fuel Level',
  ev_battery_level:      'EV Battery Level',
  ev_range_estimate:     'EV Range Estimate',
};

const labelFor = (t: string) =>
  SENSOR_LABELS[t] ?? t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ─── Threshold panel ────────────────────────────────────────────────────────

interface ThresholdRow {
  sensor_type: string;
  min_value:   string; // string for controlled input
  max_value:   string;
  alert_enabled: boolean;
  existing_id?: string;
}

interface ThresholdPanelProps {
  vehicle:    Vehicle;
  sensorTypes: string[];
  onClose:    () => void;
}

function ThresholdPanel({ vehicle, sensorTypes, onClose }: ThresholdPanelProps) {
  const [rows, setRows]       = useState<ThresholdRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('thresholds')
        .select('*')
        .eq('vehicle_id', vehicle.id);

      const existingMap = new Map<string, Threshold>(
        (data ?? []).map(t => [t.sensor_type, t])
      );

      // Build a row for every sensor that has data, falling back to simulator defaults
      const built: ThresholdRow[] = sensorTypes.map(sensor_type => {
        const existing = existingMap.get(sensor_type);
        const cfg      = vehicleSimulator.getSensorConfig(sensor_type);
        return {
          sensor_type,
          min_value:     existing?.min_value != null ? String(existing.min_value) : String(cfg.normal_min),
          max_value:     existing?.max_value != null ? String(existing.max_value) : String(cfg.normal_max),
          alert_enabled: existing?.alert_enabled ?? true,
          existing_id:   existing?.id,
        };
      });

      setRows(built);
      setLoading(false);
    })();
  }, [vehicle.id, sensorTypes]);

  const updateRow = (idx: number, patch: Partial<ThresholdRow>) => {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const upserts = rows.map(r => ({
        ...(r.existing_id ? { id: r.existing_id } : {}),
        vehicle_id:    vehicle.id,
        sensor_type:   r.sensor_type,
        min_value:     r.min_value !== '' ? parseFloat(r.min_value) : null,
        max_value:     r.max_value !== '' ? parseFloat(r.max_value) : null,
        alert_enabled: r.alert_enabled,
      }));

      const { error } = await supabase
        .from('thresholds')
        .upsert(upserts, { onConflict: 'vehicle_id,sensor_type' });

      if (!error) setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    /* Overlay */
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-lg bg-gray-900 border-l border-gray-800 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 flex-shrink-0">
          <div>
            <h2 className="text-lg font-bold text-white">Threshold Settings</h2>
            <p className="text-xs text-gray-400 mt-0.5">{vehicle.name} · {vehicle.make} {vehicle.model}</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Column headers */}
        <div className="grid grid-cols-[1fr_90px_90px_40px] gap-3 px-6 py-2 bg-gray-800/50 border-b border-gray-800 flex-shrink-0">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Sensor</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Min</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Max</p>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Alert</p>
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto px-6 py-2">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : rows.length === 0 ? (
            <p className="text-gray-500 text-sm text-center py-16">
              No sensor data yet — connect the OBD adapter to populate sensors.
            </p>
          ) : (
            <div className="space-y-1 py-2">
              {rows.map((row, idx) => {
                const cfg = vehicleSimulator.getSensorConfig(row.sensor_type);
                return (
                  <div
                    key={row.sensor_type}
                    className="grid grid-cols-[1fr_90px_90px_40px] gap-3 items-center py-2.5 border-b border-gray-800/60 last:border-0"
                  >
                    {/* Label */}
                    <div className="min-w-0">
                      <p className="text-sm text-white font-medium truncate">{labelFor(row.sensor_type)}</p>
                      <p className="text-xs text-gray-500">{cfg.unit}</p>
                    </div>

                    {/* Min */}
                    <input
                      type="number"
                      value={row.min_value}
                      onChange={e => updateRow(idx, { min_value: e.target.value })}
                      placeholder="—"
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 text-right"
                    />

                    {/* Max */}
                    <input
                      type="number"
                      value={row.max_value}
                      onChange={e => updateRow(idx, { max_value: e.target.value })}
                      placeholder="—"
                      className="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500 text-right"
                    />

                    {/* Alert toggle */}
                    <button
                      onClick={() => updateRow(idx, { alert_enabled: !row.alert_enabled })}
                      title={row.alert_enabled ? 'Alerts on — click to disable' : 'Alerts off — click to enable'}
                      className={`p-1.5 rounded-lg transition-colors ${
                        row.alert_enabled
                          ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                          : 'bg-gray-800 text-gray-600 hover:bg-gray-700'
                      }`}
                    >
                      {row.alert_enabled
                        ? <Bell className="w-4 h-4" />
                        : <BellOff className="w-4 h-4" />
                      }
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-800 flex-shrink-0 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-500">Changes apply to new sensor readings immediately.</p>
          <button
            onClick={handleSave}
            disabled={saving || loading || rows.length === 0}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors flex-shrink-0"
          >
            {saving
              ? <Loader className="w-4 h-4 animate-spin" />
              : saved
              ? <span className="text-green-300">✓ Saved</span>
              : <><Save className="w-4 h-4" /> Save</>
            }
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function VehicleDetail({ vehicle, onBack }: VehicleDetailProps) {
  const { fleetId } = useSubscription();

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'sensors' | 'maintenance'>('sensors');

  // ── Sensor state ───────────────────────────────────────────────────────────
  const [sensorData, setSensorData]     = useState<Map<string, SensorData>>(new Map());
  const [previousData, setPreviousData] = useState<Map<string, number>>(new Map());
  const [showThresholds, setShowThresholds] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // ── Maintenance state ──────────────────────────────────────────────────────
  const [predictions,   setPredictions]   = useState<VehiclePrediction[]>([]);
  const [serviceLogs,   setServiceLogs]   = useState<VehicleServiceLog[]>([]);
  const [maintLoading,  setMaintLoading]  = useState(false);
  const [serviceModal,  setServiceModal]  = useState<VehiclePrediction | null>(null);
  // Mark-as-serviced form state
  const [svcDate,  setSvcDate]  = useState(new Date().toISOString().slice(0, 10));
  const [svcKm,    setSvcKm]    = useState('');
  const [svcCost,  setSvcCost]  = useState('');
  const [svcNotes, setSvcNotes] = useState('');
  const [svcSaving,setSvcSaving]= useState(false);
  const [svcError, setSvcError] = useState('');

  const loadMaintenance = async () => {
    setMaintLoading(true);
    try {
      const [predsRes, logsRes] = await Promise.all([
        supabase
          .from('maintenance_predictions')
          .select('id, prediction_type, description, due_at_km, due_date, urgency, status')
          .eq('vehicle_id', vehicle.id)
          .neq('status', 'completed')
          .order('status', { ascending: false })
          .order('due_date', { ascending: true }),
        supabase
          .from('maintenance_logs')
          .select('id, service_type, service_date, odometer_km, cost, notes')
          .eq('vehicle_id', vehicle.id)
          .order('service_date', { ascending: false })
          .limit(20),
      ]);
      if (predsRes.data) setPredictions(predsRes.data as VehiclePrediction[]);
      if (logsRes.data)  setServiceLogs(logsRes.data  as VehicleServiceLog[]);
    } catch (e) {
      console.error('Maintenance load error:', e);
    } finally {
      setMaintLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'maintenance') loadMaintenance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, vehicle.id]);

  const handleMarkServiced = async () => {
    if (!serviceModal || !fleetId) return;
    setSvcSaving(true);
    setSvcError('');
    try {
      const { error: logErr } = await supabase.from('maintenance_logs').insert({
        vehicle_id:   vehicle.id,
        fleet_id:     fleetId,
        service_type: serviceModal.prediction_type,
        service_date: svcDate,
        odometer_km:  svcKm   ? parseFloat(svcKm)   : null,
        cost:         svcCost ? parseFloat(svcCost)  : null,
        notes:        svcNotes.trim() || null,
      });
      if (logErr) throw logErr;
      await supabase
        .from('maintenance_predictions')
        .update({ status: 'completed' })
        .eq('id', serviceModal.id);
      setServiceModal(null);
      setSvcDate(new Date().toISOString().slice(0, 10));
      setSvcKm(''); setSvcCost(''); setSvcNotes('');
      await loadMaintenance();
    } catch (e: any) {
      setSvcError(e.message ?? 'Save failed.');
    } finally {
      setSvcSaving(false);
    }
  };

  // Keep a stable ref to sensorData for the realtime callback
  const sensorDataRef = useRef(sensorData);
  sensorDataRef.current = sensorData;
  const previousDataRef = useRef(previousData);
  previousDataRef.current = previousData;

  // ── Load latest reading per sensor_type on mount ───────────────────────────
  useEffect(() => {
    (async () => {
      setLoadingHistory(true);
      try {
        // Fetch enough rows to cover all sensor types (latest first)
        const { data } = await supabase
          .from('sensor_data')
          .select('*')
          .eq('vehicle_id', vehicle.id)
          .order('timestamp', { ascending: false })
          .limit(500);

        if (data && data.length > 0) {
          // Keep only the most-recent reading per sensor_type
          const latestMap = new Map<string, SensorData>();
          data.forEach(row => {
            if (!latestMap.has(row.sensor_type)) {
              latestMap.set(row.sensor_type, row as SensorData);
            }
          });
          setSensorData(latestMap);
        }
      } catch (e) {
        console.error('Error loading sensor history:', e);
      } finally {
        setLoadingHistory(false);
      }
    })();
  }, [vehicle.id]);

  // ── Subscribe to real-time inserts ────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = realtimeService.subscribeToSensorData(vehicle.id, (data) => {
      const newMap  = new Map(sensorDataRef.current);
      const prevMap = new Map(previousDataRef.current);

      data.forEach((reading) => {
        const existing = newMap.get(reading.sensor_type);
        if (existing) prevMap.set(reading.sensor_type, existing.value);
        newMap.set(reading.sensor_type, reading);
      });

      setSensorData(newMap);
      setPreviousData(prevMap);
    });

    return () => { unsubscribe(); };
  }, [vehicle.id]);

  const sensors      = Array.from(sensorData.values());
  const sensorTypes  = Array.from(sensorData.keys());

  return (
    <div className="space-y-6">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <button onClick={onBack} className="p-2 hover:bg-gray-800 rounded-lg transition-colors">
            <ArrowLeft className="w-6 h-6 text-gray-400" />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-white">{vehicle.name}</h1>
            <p className="text-gray-400">
              {vehicle.make} {vehicle.model} ({vehicle.year}) — VIN: {vehicle.vin}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowThresholds(true)}
            title="Threshold settings"
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors group"
          >
            <Settings className="w-6 h-6 text-gray-400 group-hover:text-white transition-colors" />
          </button>
        </div>
      </div>

      {/* ── Tab switcher ───────────────────────────────────────────────────── */}
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {([
          { id: 'sensors',     label: 'Sensors',     icon: Settings },
          { id: 'maintenance', label: 'Maintenance',  icon: Wrench   },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeTab === t.id
                ? 'bg-blue-600 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Vehicle info strip ─────────────────────────────────────────────── */}
      <div className="bg-gray-900 rounded-lg p-6 border border-gray-800">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-gray-400 mb-1">Status</p>
            <div className="flex items-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${vehicle.is_active ? 'bg-green-500' : 'bg-gray-600'}`} />
              <p className="text-white font-semibold">{vehicle.is_active ? 'Active' : 'Offline'}</p>
            </div>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Health Score</p>
            <p className={`text-2xl font-bold ${
              vehicle.health_score >= 80 ? 'text-green-500'
              : vehicle.health_score >= 60 ? 'text-yellow-500'
              : 'text-red-500'
            }`}>
              {vehicle.health_score.toFixed(0)}%
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-400 mb-1">Last Connected</p>
            <p className="text-white font-semibold">
              {vehicle.last_connected
                ? new Date(vehicle.last_connected).toLocaleString()
                : 'Never'}
            </p>
          </div>
        </div>
      </div>

      {/* ── Sensor grid ────────────────────────────────────────────────────── */}
      {activeTab === 'sensors' && (
        <>
          {loadingHistory ? (
            <div className="flex items-center justify-center py-16 bg-gray-900 rounded-lg border border-gray-800">
              <Loader className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          ) : sensors.length === 0 ? (
            <div className="text-center py-16 bg-gray-900 rounded-lg border border-gray-800">
              <div className="p-4 rounded-full bg-gray-800 w-fit mx-auto mb-4">
                <Settings className="w-8 h-8 text-gray-600" />
              </div>
              <p className="text-white font-medium mb-2">No sensor data yet</p>
              <p className="text-gray-500 text-sm">
                Connect the OBD adapter via the mobile app, or start the simulation to generate readings.
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white">
                  {isSimulating ? 'Live Sensor Data' : 'Last Known Sensor Readings'}
                </h2>
                <span className="text-xs text-gray-500">
                  {sensors.length} sensor{sensors.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {sensors.map((sensor) => {
                  const config = vehicleSimulator.getSensorConfig(sensor.sensor_type);
                  return (
                    <SensorCard
                      key={sensor.sensor_type}
                      sensorType={sensor.sensor_type}
                      value={sensor.value}
                      unit={sensor.unit}
                      normalMin={config.normal_min}
                      normalMax={config.normal_max}
                      previousValue={previousData.get(sensor.sensor_type)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Maintenance tab ────────────────────────────────────────────────── */}
      {activeTab === 'maintenance' && (
        <div className="space-y-6">
          {maintLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          ) : (
            <>
              {/* Predictions */}
              <div>
                <h2 className="text-lg font-bold text-white mb-3">Service Schedule</h2>
                {predictions.length === 0 ? (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 p-10 text-center">
                    <Wrench className="w-10 h-10 text-gray-700 mx-auto mb-3" />
                    <p className="text-gray-400 font-medium">No predictions for this vehicle</p>
                    <p className="text-gray-600 text-sm mt-1">
                      Go to the Maintenance page and click "Refresh Predictions".
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {predictions.map(pred => {
                      const style = PRED_STATUS_STYLE[pred.status] ?? PRED_STATUS_STYLE.upcoming;
                      const label = SERVICE_LABELS[pred.prediction_type] ?? pred.prediction_type;
                      return (
                        <div key={pred.id} className="bg-gray-900 rounded-xl border border-gray-800 p-4">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <p className="text-white font-semibold text-sm">{label}</p>
                            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${style.badge}`}>
                              {style.label}
                            </span>
                          </div>
                          {pred.description && (
                            <p className="text-xs text-gray-500 mb-2">{pred.description}</p>
                          )}
                          <div className="space-y-1 mb-3">
                            {pred.due_at_km != null && (
                              <p className="text-xs text-gray-400">
                                Due at: <span className={`font-semibold ${style.text}`}>
                                  {pred.due_at_km.toLocaleString('en-IN')} km
                                </span>
                              </p>
                            )}
                            {pred.due_date && (
                              <p className="text-xs text-gray-400">
                                By: <span className={`font-semibold ${style.text}`}>
                                  {new Date(pred.due_date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}
                                </span>
                              </p>
                            )}
                          </div>
                          <button
                            onClick={() => { setServiceModal(pred); setSvcDate(new Date().toISOString().slice(0,10)); }}
                            className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-green-600/20 hover:bg-green-600/30 border border-green-600/30 text-green-400 text-xs font-medium transition-colors"
                          >
                            <CheckCircle className="w-3.5 h-3.5" />
                            Mark as Serviced
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Service history */}
              <div>
                <h2 className="text-lg font-bold text-white mb-3 flex items-center gap-2">
                  <History className="w-5 h-5 text-gray-400" />
                  Service History
                </h2>
                {serviceLogs.length === 0 ? (
                  <p className="text-gray-500 text-sm">No service records yet for this vehicle.</p>
                ) : (
                  <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-gray-800">
                          {['Service', 'Date', 'Odometer', 'Cost', 'Notes'].map(col => (
                            <th key={col} className="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {serviceLogs.map(log => (
                          <tr key={log.id} className="hover:bg-gray-800/40 transition-colors">
                            <td className="px-4 py-3 text-sm text-gray-300">
                              {SERVICE_LABELS[log.service_type] ?? log.service_type}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-300">
                              {new Date(log.service_date).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-300">
                              {log.odometer_km != null ? `${log.odometer_km.toLocaleString('en-IN')} km` : '—'}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-300">
                              {log.cost != null ? `₹${log.cost.toLocaleString('en-IN')}` : '—'}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                              {log.notes ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Mark-as-Serviced modal ──────────────────────────────────────────── */}
      {serviceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="flex items-start justify-between p-5 border-b border-gray-800">
              <div>
                <h2 className="text-white font-bold">Mark as Serviced</h2>
                <p className="text-gray-400 text-sm mt-0.5">
                  {SERVICE_LABELS[serviceModal.prediction_type] ?? serviceModal.prediction_type} — {vehicle.name}
                </p>
              </div>
              <button onClick={() => setServiceModal(null)} className="text-gray-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Service Date *</label>
                <input type="date" value={svcDate} max={new Date().toISOString().slice(0,10)}
                  onChange={e => setSvcDate(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Odometer (km)</label>
                <input type="number" placeholder="e.g. 45000" value={svcKm} min="0"
                  onChange={e => setSvcKm(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Cost (₹)</label>
                <input type="number" placeholder="e.g. 1200" value={svcCost} min="0"
                  onChange={e => setSvcCost(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-xs text-gray-400 font-medium mb-1">Notes</label>
                <textarea placeholder="Optional notes…" value={svcNotes} rows={2}
                  onChange={e => setSvcNotes(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 resize-none" />
              </div>
              {svcError && (
                <p className="text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{svcError}</p>
              )}
            </div>
            <div className="flex gap-3 px-5 pb-5">
              <button onClick={() => setServiceModal(null)}
                className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-400 hover:text-white text-sm font-medium transition-colors">
                Cancel
              </button>
              <button onClick={handleMarkServiced} disabled={svcSaving || !svcDate}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
                {svcSaving ? <Loader className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {svcSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Threshold settings panel ────────────────────────────────────────── */}
      {showThresholds && (
        <ThresholdPanel
          vehicle={vehicle}
          sensorTypes={sensorTypes}
          onClose={() => setShowThresholds(false)}
        />
      )}
    </div>
  );
}

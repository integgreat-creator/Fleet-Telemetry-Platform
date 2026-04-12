import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Play, Square, Settings, X, Save, Bell, BellOff, Loader } from 'lucide-react';
import { supabase, type Vehicle, type SensorData, type Threshold } from '../lib/supabase';
import { realtimeService } from '../services/realtimeService';
import { vehicleSimulator } from '../services/simulatorService';
import SensorCard from '../components/SensorCard';

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
  const [sensorData, setSensorData]     = useState<Map<string, SensorData>>(new Map());
  const [previousData, setPreviousData] = useState<Map<string, number>>(new Map());
  const [isSimulating, setIsSimulating] = useState(vehicle.is_active);
  const [showThresholds, setShowThresholds] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

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

  const handleToggleSimulation = async () => {
    if (isSimulating) {
      await realtimeService.stopSimulation(vehicle.id);
      setIsSimulating(false);
    } else {
      await realtimeService.startSimulation(vehicle);
      setIsSimulating(true);
    }
  };

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
            onClick={handleToggleSimulation}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${
              isSimulating
                ? 'bg-red-600 hover:bg-red-700 text-white'
                : 'bg-green-600 hover:bg-green-700 text-white'
            }`}
          >
            {isSimulating ? (
              <><Square className="w-5 h-5" /><span>Stop Simulation</span></>
            ) : (
              <><Play className="w-5 h-5" /><span>Start Simulation</span></>
            )}
          </button>
          <button
            onClick={() => setShowThresholds(true)}
            title="Threshold settings"
            className="p-2 hover:bg-gray-800 rounded-lg transition-colors group"
          >
            <Settings className="w-6 h-6 text-gray-400 group-hover:text-white transition-colors" />
          </button>
        </div>
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
